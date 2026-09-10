import { isFromEngine, type FromEngine } from '../shared/engineMsg.js'
import type { EngineState, VoiceCordEvent } from '../shared/ipc.js'

/**
 * エンジンの監督。
 *
 * frida は Discord の main プロセスに載せない。utilityProcess の子に隔離し、
 * ネイティブが落ちても Discord は生き残る。これが「Discord ごと死ぬ」への
 * 唯一の実効的な答えなので、ここでは **絶対に throw しない**。
 * エンジンが起動できなくても FAB は出て、理由が読める状態を保つ。
 *
 * 再起動はバックオフ付き。落ち続けるものを 3 秒ごとに起こし直すと、
 * ログが溢れるうえ CPU も食う。一定時間生き延びたら間隔を戻す。
 */

/** utilityProcess のうち、ここで使うものだけ */
export interface EngineProcessLike {
  /** 子プロセスの PID。まだ起きていなければ undefined */
  readonly pid?: number | undefined
  postMessage(message: unknown, transfer?: unknown[]): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  readonly stdout: StreamLike | null
  readonly stderr: StreamLike | null
}

export interface StreamLike {
  on(event: 'data', listener: (chunk: unknown) => void): void
}

export type TimerHandle = unknown

export interface EngineHostDeps {
  /** 子プロセスを起こす。throw してよい（ここで捕まえる） */
  fork: () => EngineProcessLike
  /** status / log / engine イベントの出口 */
  emit: (e: VoiceCordEvent) => void
  /** エンジンの生死が変わったときに呼ばれる */
  onState: (state: EngineState, attachedPid: number | null, error: string | null) => void
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
  /** 現在時刻（ms）。生存時間の判定に使う */
  now: () => number
}

export interface EngineHost {
  start(): void
  /** 監督を止める。以後は再起動しない */
  stop(): void
  /** 手動リトライ。今の子を殺して即座に起こし直す */
  restart(): void
  /** engine へ要求を投げて応答を待つ。エンジンが居なければ理由つきで reject */
  request(ch: string, args: unknown[], transfer?: unknown[]): Promise<unknown>
  /** 現在のエンジンの生死 */
  state(): EngineState
  /** 今動いている子プロセスの PID。居なければ null */
  pid(): number | null
}

/**
 * 再起動の間隔。落ち続けるときに広げ、一定時間生き延びたら先頭へ戻す。
 * pidfind の supervisor と同じ考え方で揃えてある。
 */
export const RESTART_BACKOFF_MS: readonly number[] = [3_000, 5_000, 10_000, 30_000]

/** この時間生き延びたら「正常に動いた」と見なしてバックオフを戻す */
export const HEALTHY_UPTIME_MS = 10_000

export function createEngineHost(deps: EngineHostDeps): EngineHost {
  let child: EngineProcessLike | null = null
  let stopped = false
  let backoffIndex = 0
  let restartTimer: TimerHandle | null = null
  let spawnedAt = 0
  let engineState: EngineState = 'starting'
  let seq = 0

  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  const setState = (s: EngineState, pid: number | null, err: string | null): void => {
    engineState = s
    deps.onState(s, pid, err)
  }

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    deps.emit({ ev: 'log', level, message })
  }

  /**
   * 待っている要求を全部落とす。
   * これをやらないと、エンジンが死んだときに UI の Promise が永久に返らず、
   * 「ボタンを押しても何も起きない」という一番分かりにくい壊れ方になる。
   */
  const rejectAllPending = (reason: string): void => {
    for (const [, p] of pending) p.reject(new Error(reason))
    pending.clear()
  }

  const pipe = (stream: StreamLike | null, level: 'info' | 'error'): void => {
    if (stream === null) return
    stream.on('data', (chunk) => {
      const text = String(chunk).trimEnd()
      if (text !== '') log(level, `[engine] ${text}`)
    })
  }

  const onMessage = (raw: unknown): void => {
    if (!isFromEngine(raw)) {
      log('warn', `[engine] 解釈できない電文を無視しました: ${briefly(raw)}`)
      return
    }
    const msg: FromEngine = raw
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (p === undefined) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error ?? 'エンジンが理由なく失敗を返しました'))
      return
    }
    if (msg.t === 'ev') {
      deps.emit({ ev: 'engine', payload: msg.payload })
      return
    }
    setState(msg.state, msg.attachedPid, msg.error)
  }

  const onExit = (code: number): void => {
    child = null
    rejectAllPending(`エンジンが終了しました（コード ${code}）`)
    if (stopped) return

    // 十分に生き延びていたなら、これは「たまたま落ちた」。間隔を戻す
    if (deps.now() - spawnedAt >= HEALTHY_UPTIME_MS) backoffIndex = 0
    const wait = RESTART_BACKOFF_MS[Math.min(backoffIndex, RESTART_BACKOFF_MS.length - 1)] as number
    backoffIndex += 1

    setState('failed', null, `エンジンが終了しました（コード ${code}）。${wait / 1000} 秒後に再起動します`)
    restartTimer = deps.setTimer(() => {
      restartTimer = null
      spawn()
    }, wait)
  }

  const spawn = (): void => {
    if (stopped || child !== null) return
    setState('starting', null, null)
    try {
      const c = deps.fork()
      child = c
      spawnedAt = deps.now()
      c.on('message', onMessage)
      c.on('exit', onExit)
      pipe(c.stdout, 'info')
      pipe(c.stderr, 'error')
    } catch (e) {
      // fork 自体が失敗した（ファイルが無い、frida のロードに失敗した等）。
      // 黙って諦めず、理由を状態に出したうえで再試行する
      child = null
      const reason = e instanceof Error ? e.message : String(e)
      const wait = RESTART_BACKOFF_MS[
        Math.min(backoffIndex, RESTART_BACKOFF_MS.length - 1)
      ] as number
      backoffIndex += 1
      setState('failed', null, `エンジンを起動できませんでした: ${reason}`)
      restartTimer = deps.setTimer(() => {
        restartTimer = null
        spawn()
      }, wait)
    }
  }

  const cancelRestart = (): void => {
    if (restartTimer === null) return
    deps.clearTimer(restartTimer)
    restartTimer = null
  }

  return {
    start: () => {
      stopped = false
      spawn()
    },

    stop: () => {
      stopped = true
      cancelRestart()
      rejectAllPending('エンジンを停止しました')
      const c = child
      child = null
      if (c !== null) {
        try {
          c.kill()
        } catch {
          // 既に死んでいても構わない
        }
      }
    },

    restart: () => {
      cancelRestart()
      backoffIndex = 0
      const c = child
      if (c === null) {
        spawn()
        return
      }
      // kill すると exit が来る。そこで再起動されるとバックオフを挟んでしまうので、
      // 先に参照を外して自分で起こし直す
      child = null
      rejectAllPending('エンジンを再起動しました')
      try {
        c.kill()
      } catch {
        // 既に死んでいても構わない
      }
      spawn()
    },

    request: (ch, args, transfer) =>
      new Promise<unknown>((resolve, reject) => {
        const c = child
        if (c === null) {
          reject(new Error('エンジンが動いていません。しばらく待つか、再アタッチしてください'))
          return
        }
        const id = ++seq
        pending.set(id, { resolve, reject })
        try {
          c.postMessage({ t: 'req', id, ch, args }, transfer)
        } catch (e) {
          pending.delete(id)
          reject(new Error(`エンジンへ送れませんでした: ${e instanceof Error ? e.message : String(e)}`))
        }
      }),

    state: () => engineState,

    pid: () => child?.pid ?? null
  }
}

/** 解釈できなかった電文をログに出すときの短縮 */
function briefly(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s.length > 200 ? `${s.slice(0, 200)}…` : s
  } catch {
    return String(v)
  }
}
