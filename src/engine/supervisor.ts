/**
 * 注入先プロセスの自動検出と常時監視。
 *
 * **注入先は renderer である。** 旧解析は audio utility だと書いていたが、
 * 実機（Canary 1.0.1169）では audio.mojom.AudioService がサンドボックスで
 * frida の注入を拒否し、krisp と discord_voice の両方を持っているのは
 * renderer だった。renderer に入れるのは Discord がメインウィンドウに
 * sandbox:false を設定しているため（preload を刺せるのと同じ理由）。
 *
 * 移植元の `pidfind.ts` はそのままでは使えない。旧構成は別アプリから Discord を
 * 探す前提で、実行ファイル名で候補を絞っていた。新構成では**自分が Discord の中に
 * 居る**ので、
 *
 *   - 候補は全部 `Discord.exe`（Chromium の子プロセスは全部同名）
 *   - 列挙結果に**自分自身**と crashpad-handler が混ざる
 *
 * したがって「自分を除く」「親が自分の親（= browser プロセス）であるものだけ」で絞る。
 * 親 PID は frida の `enumerateProcesses({scope:'metadata'})` が返す
 * （Windows で返ることは実機で確認済み）。
 *
 * **不合格は恒久ではない。** 当初は「krisp を持たない PID は二度と見ない」設計に
 * していたが、これは注入先が VC 参加時に新しく生まれるプロセスである前提だった。
 * 実際の注入先は**長命な renderer が VC 参加時に krisp を後から載せる**形なので、
 * 起動直後に一度検査して恒久的に落とすと、その後 VC に入っても永久に噛まない
 * （実機で踏んだ）。不合格には期限を付ける。
 */

export interface ProcessInfo {
  pid: number
  name: string
  /** 取れなければ null。その場合は自分を除くだけで運用する */
  ppid: number | null
}

export type TimerHandle = unknown

/** 検査の結果。フレーム長とレートは測れなければ null */
export interface ProbeResult {
  found: boolean
  frameSamples: number | null
  sampleRate: number | null
}

export interface SupervisorDeps {
  /** プロセス一覧。attach しないので安い */
  listProcesses: () => Promise<ProcessInfo[]>
  /** krisp の処理関数を持つか調べ、ついでにフレーム長とレートを測る */
  probe: (pid: number) => Promise<ProbeResult>
  /** 見つかったので hook を注入する。成功したら true */
  attach: (pid: number, probe: ProbeResult) => Promise<boolean>
  /** エンジン自身の PID。列挙結果に必ず混ざるので除外が要る */
  selfPid: number
  /** エンジンの親 = Discord の browser プロセス。注入先の親でもある */
  parentPid: number
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
  /** 現在時刻（ms）。不合格の期限判定に使う */
  now: () => number
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 見つかった／見失ったときに呼ばれる */
  onAttached?: (pid: number, probe: ProbeResult) => void
  onLost?: () => void
}

/**
 * 走査の間隔。見つからないうちは広げていく。
 * 子プロセスの集合が変わったら先頭へ戻す（VC に入った瞬間に素早く噛むため）。
 */
export const SCAN_BACKOFF_MS: readonly number[] = [3_000, 5_000, 10_000, 30_000]

/** 噛んだ後の見張り間隔。detached が来なかった場合の保険 */
export const WATCH_INTERVAL_MS = 30_000

/**
 * 「krisp を持っていなかった」を覚えておく時間。
 * 短すぎると毎回の走査で全プロセスに attach しに行き、長すぎると VC 参加に
 * 気付くのが遅れる。krisp を持たないプロセスの検査は即答なので短めでよい。
 */
export const NO_KRISP_RETRY_MS = 5_000

/**
 * 「そもそも attach できなかった」を覚えておく時間。
 * gpu-process と audio.mojom.AudioService はサンドボックスで恒久的に拒否するので、
 * 毎回試すとログが溢れるだけになる。
 */
export const UNREACHABLE_RETRY_MS = 60_000

export interface Supervisor {
  start(): void
  stop(): void
  /** 手動で今すぐ走査し直す。detached を受けたときにも呼ぶ */
  rescan(): void
  /** 今噛んでいる PID。居なければ null */
  attachedPid(): number | null
  /** frida のセッションが切れた。即座に探し直す */
  onDetached(): void
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let stopped = true
  let timer: TimerHandle | null = null
  let backoffIndex = 0
  let attached: number | null = null
  /**
   * しばらく見ない PID とその期限。
   * 恒久的に落とさないのが要点（renderer は後から krisp を載せる）。
   */
  const cooldown = new Map<number, number>()
  /** 前回の候補集合。変化したらバックオフを戻す */
  let lastCandidates = ''
  /** 走査の多重起動を防ぐ。enumerate + probe は秒単位でかかりうる */
  let scanning = false

  const log = (level: 'info' | 'warn' | 'error', msg: string): void => {
    try {
      deps.onLog?.(level, msg)
    } catch {
      // ログの failure で走査を止めない
    }
  }

  const cancel = (): void => {
    if (timer === null) return
    deps.clearTimer(timer)
    timer = null
  }

  const schedule = (ms: number): void => {
    cancel()
    if (stopped) return
    timer = deps.setTimer(() => {
      timer = null
      void tick()
    }, ms)
  }

  /** 自分と、親が違うものを落とす */
  const candidatesOf = (procs: ProcessInfo[]): number[] => {
    const out: number[] = []
    for (const p of procs) {
      if (p.pid === deps.selfPid) continue
      // ppid が取れない環境では「自分を除く」だけで運用する。
      // 候補が数個増えるだけで、不合格キャッシュがあるので実害は小さい
      if (p.ppid !== null && p.ppid !== deps.parentPid) continue
      out.push(p.pid)
    }
    return out
  }

  const tick = async (): Promise<void> => {
    if (stopped || scanning) return
    scanning = true
    try {
      const procs = await safeList()
      if (stopped) return

      if (attached !== null) {
        // 噛んだ後の見張り。detached が来ないまま消えていたら探し直す
        if (procs.some((p) => p.pid === attached)) {
          schedule(WATCH_INTERVAL_MS)
          return
        }
        log('warn', `attach 先 ${attached} が消えていました。探し直します`)
        attached = null
        notifyLost()
      }

      const cands = candidatesOf(procs)
      const key = cands.join(',')
      if (key !== lastCandidates) {
        // 子プロセスの集合が変わった = VC に入った可能性がある。すぐ探す
        lastCandidates = key
        backoffIndex = 0
      }

      for (const pid of cands) {
        if (stopped) return
        const until = cooldown.get(pid)
        if (until !== undefined && deps.now() < until) continue
        let hit: ProbeResult = { found: false, frameSamples: null, sampleRate: null }
        try {
          hit = await deps.probe(pid)
        } catch (e) {
          // attach 自体ができなかった。gpu-process と audio.mojom.AudioService は
          // サンドボックスで恒久的に拒否するので、しばらく見ないことにする。
          // ただし恒久的には諦めない（起動直後だけ弾かれることもある）
          if (until === undefined) log('info', `PID ${pid} を検査できませんでした: ${msgOf(e)}`)
          cooldown.set(pid, deps.now() + UNREACHABLE_RETRY_MS)
          continue
        }
        if (!hit.found) {
          // 今は krisp を持っていない。**恒久的には落とさない** —
          // renderer は VC に入った時点で krisp を載せるため
          cooldown.set(pid, deps.now() + NO_KRISP_RETRY_MS)
          continue
        }
        // 見つかったら期限を消す（次に見失ってもすぐ探し直せる）
        cooldown.delete(pid)
        if (stopped) return
        let ok = false
        try {
          ok = await deps.attach(pid, hit)
        } catch (e) {
          log('error', `PID ${pid} への注入に失敗しました: ${msgOf(e)}`)
        }
        if (ok) {
          attached = pid
          backoffIndex = 0
          log(
            'info',
            `注入先に噛みました（PID ${pid} / ${hit.frameSamples ?? '?'} サンプル ・ ${hit.sampleRate ?? '?'} Hz）`
          )
          try {
            deps.onAttached?.(pid, hit)
          } catch {
            // 通知先の失敗で監視を止めない
          }
          schedule(WATCH_INTERVAL_MS)
          return
        }
        // 注入に失敗しただけ。krisp は持っているので不合格にはしない
      }

      const wait = SCAN_BACKOFF_MS[Math.min(backoffIndex, SCAN_BACKOFF_MS.length - 1)] as number
      backoffIndex += 1
      schedule(wait)
    } finally {
      scanning = false
    }
  }

  const safeList = async (): Promise<ProcessInfo[]> => {
    try {
      return await deps.listProcesses()
    } catch (e) {
      log('warn', `プロセスを列挙できませんでした: ${msgOf(e)}`)
      return []
    }
  }

  const notifyLost = (): void => {
    try {
      deps.onLost?.()
    } catch {
      // 通知先の失敗で監視を止めない
    }
  }

  return {
    start: () => {
      stopped = false
      backoffIndex = 0
      schedule(0)
    },

    stop: () => {
      stopped = true
      cancel()
    },

    rescan: () => {
      backoffIndex = 0
      schedule(0)
    },

    attachedPid: () => attached,

    onDetached: () => {
      if (attached !== null) {
        // 同じプロセスがまだ生きていて frida だけ切れたのかもしれない。
        // 不合格にはせず、次の走査で噛み直せるようにする
        attached = null
        notifyLost()
      }
      backoffIndex = 0
      schedule(0)
    }
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
