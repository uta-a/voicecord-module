import { describe, expect, it } from 'vitest'
import {
  createSupervisor,
  NO_KRISP_RETRY_MS,
  SCAN_BACKOFF_MS,
  UNREACHABLE_RETRY_MS,
  WATCH_INTERVAL_MS,
  type ProcessInfo,
  type ProbeResult,
  type Supervisor
} from '../src/engine/supervisor.js'

/**
 * audio utility の自動検出。
 *
 * ここが壊れると「VC に入っても緑にならない」か、逆に「自分自身や無関係な
 * プロセスに噛みに行く」になる。Chromium の子プロセスは全部同名なので、
 * 自分の除外と親 PID での絞り込みが唯一の手がかり。
 */

const SELF = 100
const PARENT = 50

function proc(pid: number, ppid: number | null = PARENT): ProcessInfo {
  return { pid, name: 'DiscordCanary.exe', ppid }
}

interface Harness {
  sup: Supervisor
  probed: number[]
  attached: number[]
  attachedProbes: ProbeResult[]
  logs: string[]
  lost: number
  setProcs(ps: ProcessInfo[]): void
  advance(ms: number): void
  setKrisp(pids: number[]): void
  probeThrows(pid: number | null): void
  attachFails(pid: number | null): void
  /** 予約されたタイマーを 1 つ発火させ、その遅延を返す */
  fire(): Promise<number>
  pending(): number | null
}

function harness(): Harness {
  let procs: ProcessInfo[] = []
  let krisp = new Set<number>()
  let probeThrowPid: number | null = null
  let attachFailPid: number | null = null
  const probed: number[] = []
  const attached: number[] = []
  const attachedProbes: ProbeResult[] = []
  const logs: string[] = []
  let lost = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let seq = 0
  let now = 0

  const sup = createSupervisor({
    listProcesses: async () => procs,
    probe: async (pid) => {
      probed.push(pid)
      if (pid === probeThrowPid) throw new Error('attach を弾かれました')
      return krisp.has(pid)
        ? { found: true, frameSamples: 320, sampleRate: 32000 }
        : { found: false, frameSamples: null, sampleRate: null }
    },
    attach: async (pid, probe) => {
      if (pid === attachFailPid) return false
      attached.push(pid)
      attachedProbes.push(probe)
      return true
    },
    selfPid: SELF,
    parentPid: PARENT,
    setTimer: (fn, ms) => {
      const h = ++seq
      timers.set(h, { fn, ms })
      return h
    },
    clearTimer: (h) => void timers.delete(h as number),
    now: () => now,
    onLog: (_l, m) => void logs.push(m),
    onLost: () => void (lost += 1)
  })

  const h: Harness = {
    sup,
    probed,
    attached,
    attachedProbes,
    logs,
    get lost() {
      return lost
    },
    setProcs: (ps) => void (procs = ps),
    advance: (ms) => void (now += ms),
    setKrisp: (pids) => void (krisp = new Set(pids)),
    probeThrows: (pid) => void (probeThrowPid = pid),
    attachFails: (pid) => void (attachFailPid = pid),
    fire: async () => {
      const [k, t] = [...timers.entries()][0] as [number, { fn: () => void; ms: number }]
      timers.delete(k)
      t.fn()
      // 走査は非同期。マイクロタスクを吐き出させる
      await new Promise((r) => setTimeout(r, 0))
      return t.ms
    },
    pending: () => {
      const first = [...timers.values()][0]
      return first === undefined ? null : first.ms
    }
  } as Harness
  return h
}

/** start してから最初の走査を回す */
async function run(h: Harness): Promise<void> {
  h.sup.start()
  await h.fire()
}

describe('候補の絞り込み', () => {
  it('自分自身は候補にしない（列挙結果に必ず混ざる）', async () => {
    const h = harness()
    h.setProcs([proc(SELF), proc(200)])
    h.setKrisp([SELF, 200])
    await run(h)
    expect(h.probed).toEqual([200])
    expect(h.attached).toEqual([200])
  })

  it('親が違うプロセスは候補にしない', async () => {
    const h = harness()
    h.setProcs([proc(200, 999), proc(201, PARENT)])
    h.setKrisp([200, 201])
    await run(h)
    expect(h.probed).toEqual([201])
  })

  it('ppid が取れない環境では自分を除くだけで運用する', async () => {
    const h = harness()
    h.setProcs([proc(SELF, null), proc(200, null)])
    h.setKrisp([200])
    await run(h)
    expect(h.probed).toEqual([200])
  })
})

describe('検査と注入', () => {
  it('krisp を持たない PID はしばらく見ない（毎回の走査で全部に attach しない）', async () => {
    const h = harness()
    h.setProcs([proc(200), proc(201)])
    h.setKrisp([])
    await run(h)
    expect(h.probed).toEqual([200, 201])
    await h.fire()
    // 期限内なので増えていない
    expect(h.probed).toEqual([200, 201])
  })

  it('**恒久的には落とさない。** 後から krisp を載せた renderer に噛める', async () => {
    // 実機で踏んだ事故の再現。注入先は VC 参加時に新しく生まれるプロセスではなく、
    // 長命な renderer が VC 参加時に krisp を後から載せる形だった。
    // 恒久的に不合格にすると、その後 VC に入っても永久に噛まない
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([])
    await run(h)
    expect(h.attached).toEqual([])

    // ここで VC に入る。プロセスは同じまま krisp が載る
    h.setKrisp([200])
    h.advance(NO_KRISP_RETRY_MS + 1)
    await h.fire()
    expect(h.attached).toEqual([200])
  })

  it('attach できない PID はより長く見ない（gpu と audio はサンドボックスで恒久的に拒否する）', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.probeThrows(200)
    await run(h)
    expect(h.probed).toEqual([200])

    // krisp 不在の期限では戻らない
    h.advance(NO_KRISP_RETRY_MS + 1)
    await h.fire()
    expect(h.probed).toEqual([200])

    h.advance(UNREACHABLE_RETRY_MS)
    await h.fire()
    expect(h.probed).toEqual([200, 200])
  })

  it('attach できない PID のログは繰り返さない（3 秒ごとに溢れさせない）', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.probeThrows(200)
    await run(h)
    h.advance(UNREACHABLE_RETRY_MS + 1)
    await h.fire()
    expect(h.logs.filter((l) => l.includes('検査できませんでした'))).toHaveLength(1)
  })

  it('注入に失敗しても不合格にしない（krisp は持っている）', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    h.attachFails(200)
    await run(h)
    expect(h.attached).toEqual([])
    // 期限を置かずに次の走査でもう一度見る
    await h.fire()
    expect(h.probed).toEqual([200, 200])
  })

  it('実測したフレーム長とレートが attach と通知まで届く', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    await run(h)
    expect(h.attachedProbes).toEqual([{ found: true, frameSamples: 320, sampleRate: 32000 }])
    expect(h.logs.some((l) => l.includes('320 サンプル') && l.includes('32000 Hz'))).toBe(true)
  })

  it('見つけたら噛んで、以後は見張り間隔になる', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    await run(h)
    expect(h.sup.attachedPid()).toBe(200)
    expect(h.pending()).toBe(WATCH_INTERVAL_MS)
  })
})

describe('走査の間隔', () => {
  it('見つからないうちは広がり、最後の値で頭打ちになる', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([])
    h.sup.start()
    await h.fire() // 初回（遅延 0）
    const seen: number[] = []
    for (let i = 0; i < SCAN_BACKOFF_MS.length + 1; i++) seen.push(await h.fire())
    const capped = SCAN_BACKOFF_MS[SCAN_BACKOFF_MS.length - 1] as number
    expect(seen).toEqual([...SCAN_BACKOFF_MS, capped])
  })

  it('子プロセスの集合が変わったら先頭へ戻す（VC に入った瞬間に素早く噛む）', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([])
    h.sup.start()
    await h.fire()
    await h.fire()
    expect(h.pending()).toBe(SCAN_BACKOFF_MS[1])

    // audio utility が現れた
    h.setProcs([proc(200), proc(300)])
    h.setKrisp([300])
    await h.fire()
    expect(h.sup.attachedPid()).toBe(300)
  })
})

describe('見失ったとき', () => {
  it('detached を受けたら即座に探し直す', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    await run(h)
    expect(h.sup.attachedPid()).toBe(200)

    h.sup.onDetached()
    expect(h.sup.attachedPid()).toBeNull()
    expect(h.lost).toBe(1)
    expect(h.pending()).toBe(0)
  })

  it('detached の後も同じ PID に噛み直せる（不合格にしない）', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    await run(h)
    h.sup.onDetached()
    await h.fire()
    expect(h.attached).toEqual([200, 200])
  })

  it('detached が来ないまま消えていたら、見張りで気付く', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    await run(h)

    h.setProcs([])
    await h.fire()
    expect(h.sup.attachedPid()).toBeNull()
    expect(h.lost).toBe(1)
    expect(h.logs.some((l) => l.includes('消えていました'))).toBe(true)
  })
})

describe('壊れても止まらない', () => {
  it('プロセスを列挙できなくても走査を続ける', async () => {
    const timers = new Map<number, { fn: () => void; ms: number }>()
    let seq = 0
    const logs: string[] = []
    const sup = createSupervisor({
      listProcesses: () => Promise.reject(new Error('device がありません')),
      probe: async () => ({ found: false, frameSamples: null, sampleRate: null }),
      attach: async () => true,
      selfPid: SELF,
      parentPid: PARENT,
      setTimer: (fn, ms) => {
        const h = ++seq
        timers.set(h, { fn, ms })
        return h
      },
      clearTimer: (h) => void timers.delete(h as number),
      now: () => 0,
      onLog: (_l, m) => void logs.push(m)
    })
    sup.start()
    const [k, t] = [...timers.entries()][0] as [number, { fn: () => void; ms: number }]
    timers.delete(k)
    t.fn()
    await new Promise((r) => setTimeout(r, 0))
    expect(logs.some((l) => l.includes('列挙できませんでした'))).toBe(true)
    // 次の走査が予約されていること
    expect(timers.size).toBe(1)
  })

  it('stop すると以後走査しない', async () => {
    const h = harness()
    h.setProcs([proc(200)])
    h.setKrisp([200])
    h.sup.start()
    h.sup.stop()
    expect(h.pending()).toBeNull()
    expect(h.probed).toEqual([])
  })
})
