import { describe, expect, it } from 'vitest'
import {
  createEngineHost,
  HEALTHY_UPTIME_MS,
  RESTART_BACKOFF_MS,
  type EngineProcessLike,
  type StreamLike
} from '../src/patcher/engineHost.js'
import type { EngineState, VoiceCordEvent } from '../src/shared/ipc.js'

/**
 * エンジンの監督。
 *
 * ここが守るのは 2 つ。エンジンが死んでも Discord も UI も巻き添えにしないこと、
 * そして死んだときに待っている要求を必ず落とすこと。落とさないと UI の Promise が
 * 永久に返らず「ボタンを押しても何も起きない」という一番分かりにくい壊れ方になる。
 */

class FakeStream implements StreamLike {
  private listeners: Array<(c: unknown) => void> = []
  on(_e: 'data', cb: (c: unknown) => void): void {
    this.listeners.push(cb)
  }
  push(chunk: string): void {
    for (const cb of this.listeners) cb(chunk)
  }
}

class FakeProc implements EngineProcessLike {
  sent: unknown[] = []
  killed = false
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  private onMessage: ((m: unknown) => void) | null = null
  private onExit: ((c: number) => void) | null = null

  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  on(event: 'message' | 'exit', listener: never): void {
    if (event === 'message') this.onMessage = listener as (m: unknown) => void
    else this.onExit = listener as (c: number) => void
  }
  /** 子から親への送信を模す */
  emit(msg: unknown): void {
    this.onMessage?.(msg)
  }
  exit(code = 1): void {
    this.onExit?.(code)
  }
  /** 最後に送られた req の id */
  lastReqId(): number {
    const last = this.sent[this.sent.length - 1] as { id: number }
    return last.id
  }
}

interface Harness {
  host: ReturnType<typeof createEngineHost>
  procs: FakeProc[]
  events: VoiceCordEvent[]
  states: Array<{ state: EngineState; pid: number | null; error: string | null }>
  /** 予約されたタイマーを ms 指定で発火させる */
  fire(): number
  pendingDelay(): number | null
  setNow(t: number): void
  forkFails(msg: string | null): void
}

function harness(): Harness {
  const procs: FakeProc[] = []
  const events: VoiceCordEvent[] = []
  const states: Harness['states'] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerSeq = 0
  let now = 0
  let forkError: string | null = null

  const host = createEngineHost({
    fork: () => {
      if (forkError !== null) throw new Error(forkError)
      const p = new FakeProc()
      procs.push(p)
      return p
    },
    emit: (e) => void events.push(e),
    onState: (state, pid, error) => void states.push({ state, pid, error }),
    setTimer: (fn, ms) => {
      const h = ++timerSeq
      timers.set(h, { fn, ms })
      return h
    },
    clearTimer: (h) => void timers.delete(h as number),
    now: () => now
  })

  return {
    host,
    procs,
    events,
    states,
    fire: () => {
      const [h, t] = [...timers.entries()][0] as [number, { fn: () => void; ms: number }]
      timers.delete(h)
      t.fn()
      return t.ms
    },
    pendingDelay: () => {
      const first = [...timers.values()][0]
      return first === undefined ? null : first.ms
    },
    setNow: (t) => void (now = t),
    forkFails: (msg) => void (forkError = msg)
  }
}

const last = <T>(a: T[]): T => a[a.length - 1] as T

describe('createEngineHost', () => {
  it('start で子を起こし、starting を報告する', () => {
    const h = harness()
    h.host.start()
    expect(h.procs).toHaveLength(1)
    expect(h.states[0]).toEqual({ state: 'starting', pid: null, error: null })
  })

  it('子からの state をそのまま状態に反映する', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.emit({ t: 'state', state: 'attached', attachedPid: 4242, error: null })
    expect(last(h.states)).toEqual({ state: 'attached', pid: 4242, error: null })
    expect(h.host.state()).toBe('attached')
  })

  it('子からのイベントは engine で包んで流す（status / log の判別を潰さない）', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.emit({ t: 'ev', payload: { ev: 'vc', active: true } })
    expect(last(h.events)).toEqual({ ev: 'engine', payload: { ev: 'vc', active: true } })
  })

  it('req に対する res で Promise が解決する', async () => {
    const h = harness()
    h.host.start()
    const p = h.host.request('voicecord:play', [{ srcId: 'a' }])
    const id = h.procs[0]?.lastReqId() as number
    h.procs[0]?.emit({ t: 'res', id, ok: true, value: 'v1' })
    await expect(p).resolves.toBe('v1')
  })

  it('ok:false は理由つきで reject する', async () => {
    const h = harness()
    h.host.start()
    const p = h.host.request('voicecord:play', [])
    const id = h.procs[0]?.lastReqId() as number
    h.procs[0]?.emit({ t: 'res', id, ok: false, error: '音源がありません' })
    await expect(p).rejects.toThrow('音源がありません')
  })

  it('エンジンが居なければ要求を理由つきで断る（無言で握らない）', async () => {
    const h = harness()
    await expect(h.host.request('voicecord:play', [])).rejects.toThrow(/エンジンが動いていません/)
  })

  it('解釈できない電文は無視してログに残す', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.emit({ t: 'なにこれ' })
    expect(last(h.events)).toMatchObject({ ev: 'log', level: 'warn' })
  })

  it('stdout / stderr をログイベントに流す（別窓を開かずにエンジンのログが読める）', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.stdout.push('起動しました\n')
    h.procs[0]?.stderr.push('こわれました\n')
    expect(h.events).toContainEqual({ ev: 'log', level: 'info', message: '[engine] 起動しました' })
    expect(h.events).toContainEqual({ ev: 'log', level: 'error', message: '[engine] こわれました' })
  })

  it('空行はログに出さない', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.stdout.push('\n')
    expect(h.events).toHaveLength(0)
  })
})

describe('落ちたとき', () => {
  it('待っている要求を必ず落とす（UI の Promise を吊らせない）', async () => {
    const h = harness()
    h.host.start()
    const p = h.host.request('voicecord:play', [])
    h.procs[0]?.exit(1)
    await expect(p).rejects.toThrow(/エンジンが終了しました/)
  })

  it('failed を報告し、理由に再起動までの時間を含める', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.exit(9)
    expect(last(h.states).state).toBe('failed')
    expect(last(h.states).error).toContain('コード 9')
    expect(last(h.states).error).toContain('3 秒後')
  })

  it('3 秒後に自動で起こし直す', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.exit(1)
    expect(h.fire()).toBe(3_000)
    expect(h.procs).toHaveLength(2)
    expect(last(h.states).state).toBe('starting')
  })

  it('落ち続けるとバックオフが広がり、最後の値で頭打ちになる', () => {
    const h = harness()
    h.host.start()
    const seen: number[] = []
    for (let i = 0; i < RESTART_BACKOFF_MS.length + 2; i++) {
      last(h.procs).exit(1)
      seen.push(h.fire())
    }
    const capped = RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1] as number
    expect(seen).toEqual([...RESTART_BACKOFF_MS, capped, capped])
  })

  it('十分に生き延びていたらバックオフを先頭へ戻す', () => {
    const h = harness()
    h.host.start()
    last(h.procs).exit(1)
    expect(h.fire()).toBe(3_000)
    last(h.procs).exit(1)
    expect(h.fire()).toBe(5_000)

    // 今度は 10 秒以上生きた後に落ちる
    h.setNow(HEALTHY_UPTIME_MS + 1)
    last(h.procs).exit(1)
    expect(h.fire()).toBe(3_000)
  })

  it('fork 自体が失敗しても throw せず、理由を出して再試行する', () => {
    const h = harness()
    h.forkFails('engine.mjs がありません')
    h.host.start()
    expect(last(h.states).state).toBe('failed')
    expect(last(h.states).error).toContain('engine.mjs がありません')

    h.forkFails(null)
    expect(h.fire()).toBe(3_000)
    expect(h.procs).toHaveLength(1)
  })
})

describe('stop / restart', () => {
  it('stop は子を殺し、以後は再起動しない', () => {
    const h = harness()
    h.host.start()
    h.host.stop()
    expect(h.procs[0]?.killed).toBe(true)
    expect(h.pendingDelay()).toBeNull()
  })

  it('stop 後に子が落ちても起こし直さない', () => {
    const h = harness()
    h.host.start()
    const p = h.procs[0] as FakeProc
    h.host.stop()
    p.exit(0)
    expect(h.pendingDelay()).toBeNull()
    expect(h.procs).toHaveLength(1)
  })

  it('stop は待っている要求も落とす', async () => {
    const h = harness()
    h.host.start()
    const p = h.host.request('voicecord:play', [])
    h.host.stop()
    await expect(p).rejects.toThrow(/停止しました/)
  })

  it('restart はバックオフを挟まずその場で起こし直す', () => {
    const h = harness()
    h.host.start()
    h.host.restart()
    expect(h.procs).toHaveLength(2)
    expect(h.procs[0]?.killed).toBe(true)
    // 待ちタイマーを仕込んでいないこと（restart は即時）
    expect(h.pendingDelay()).toBeNull()
  })

  it('restart はバックオフの積み上がりも戻す', () => {
    const h = harness()
    h.host.start()
    last(h.procs).exit(1)
    expect(h.fire()).toBe(3_000)
    last(h.procs).exit(1)
    expect(h.fire()).toBe(5_000)

    h.host.restart()
    last(h.procs).exit(1)
    expect(h.fire()).toBe(3_000)
  })

  it('再起動待ちの最中に restart すると、待ちを取り消して即起こす', () => {
    const h = harness()
    h.host.start()
    h.procs[0]?.exit(1)
    expect(h.pendingDelay()).toBe(3_000)
    h.host.restart()
    expect(h.pendingDelay()).toBeNull()
    expect(h.procs).toHaveLength(2)
  })
})
