/**
 * audio utility プロセスの自動検出と常時監視。
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
 * audio utility は**音声を使い始めるまで存在しない**うえ、Chromium がクラッシュから
 * 再起動したりアイドルで畳んだりする。だから一度見つけて終わりにはできない。
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
  /** エンジンの親 = Discord の browser プロセス。audio utility の親でもある */
  parentPid: number
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
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
  /** 調べて「違った」PID。二度と attach しない */
  const rejected = new Set<number>()
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
        if (rejected.has(pid)) continue
        let hit: ProbeResult = { found: false, frameSamples: null, sampleRate: null }
        try {
          hit = await deps.probe(pid)
        } catch (e) {
          // 検査できなかった。恒久的に諦めず、次の走査でもう一度見る
          // （起動直後のプロセスは attach を弾くことがある）
          log('info', `PID ${pid} を検査できませんでした: ${msgOf(e)}`)
          continue
        }
        if (!hit.found) {
          // krisp を持っていない = 注入先ではない。二度と見ない
          rejected.add(pid)
          continue
        }
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
