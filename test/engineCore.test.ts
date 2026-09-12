import { describe, expect, it } from 'vitest'
import { createEngineCore, PRELOAD_MAX, sourceKey, type EngineCore } from '../src/engine/core.js'
import type { Injector } from '../src/engine/injector.js'
import { FridaGate, type GateTarget } from '../src/engine/transmit.js'
import type { EngineEvent, PlayReq } from '../src/shared/types.js'

/**
 * エンジン統括。
 *
 * 守っているのは 2 つ。Discord のプロセスに常駐する音源を無限に増やさないこと
 * （48k/mono/f32 は 192KB/秒あり、上限が無いと Discord のメモリが減らない）と、
 * 手元の記録と hook 側の sources がズレたときに自力で戻れること。
 */

interface Fake {
  core: EngineCore
  calls: string[]
  gate: FridaGate
  setAttached(v: boolean): void
}

function fake(): Fake {
  const calls: string[] = []
  let attached = true
  const inj = {
    get attached() {
      return attached
    },
    preload: (srcId: string) => void calls.push(`preload:${srcId}`),
    unload: (srcId: string) => void calls.push(`unload:${srcId}`),
    play: (srcId: string) => {
      calls.push(`play:${srcId}`)
      return `v${calls.length}`
    },
    stop: (v: string) => void calls.push(`stop:${v}`),
    stopAll: () => void calls.push('stopAll'),
    setVolume: (v: string, vol: number) => void calls.push(`vol:${v}=${vol}`),
    setMaster: (v: number) => void calls.push(`master:${v}`),
    calibStart: (t: string, f: number) => void calls.push(`calib:${t}/${f}`),
    calibStop: () => void calls.push('calibStop')
  } as unknown as Injector

  const target: GateTarget = {
    gateOpen: () => void calls.push('gateOpen'),
    gateClose: () => void calls.push('gateClose'),
    gateReset: () => void calls.push('gateReset')
  }
  const gate = new FridaGate(target)
  const core = createEngineCore({ inj, gate, emit: () => {} })
  return { core, calls, gate, setAttached: (v) => void (attached = v) }
}

const req = (srcId: string, fp = '1_2'): PlayReq => ({
  srcId,
  path: `C:/sounds/${srcId}.wav`,
  fp,
  vol: 1
})

const pcm = (): Buffer => Buffer.alloc(16)

describe('sourceKey', () => {
  it('指紋を混ぜる（同名で差し替えても旧 PCM を鳴らさない）', () => {
    expect(sourceKey('a', '1_2')).toBe('a@1_2')
    expect(sourceKey('a', '3_4')).not.toBe(sourceKey('a', '1_2'))
  })
})

describe('preloadPcm', () => {
  it('初回は hook へ送る', () => {
    const f = fake()
    expect(f.core.preloadPcm('a', '1_2', pcm())).toEqual({ key: 'a@1_2', sent: true })
    expect(f.calls).toEqual(['preload:a@1_2'])
  })

  it('2 回目は送り直さない（1MB を Discord のプロセスへ投げ直さない）', () => {
    const f = fake()
    f.core.preloadPcm('a', '1_2', pcm())
    expect(f.core.preloadPcm('a', '1_2', pcm())).toEqual({ key: 'a@1_2', sent: false })
    expect(f.calls).toEqual(['preload:a@1_2'])
  })

  it('噛んでいなければ理由つきで断る', () => {
    const f = fake()
    f.setAttached(false)
    expect(() => f.core.preloadPcm('a', '1_2', pcm())).toThrow(/噛んでいません/)
  })
})

describe('play', () => {
  it('プリロード済みなら鳴らす', () => {
    const f = fake()
    f.core.preloadPcm('a', '1_2', pcm())
    expect(f.core.play(req('a'))).not.toBeNull()
    expect(f.calls).toContain('play:a@1_2')
  })

  it('プリロードされていなければ理由を返す（無言で鳴らないを作らない）', () => {
    const f = fake()
    expect(() => f.core.play(req('a'))).toThrow(/hook 側にありません/)
  })

  it('噛んでいなければ理由つきで断る', () => {
    const f = fake()
    f.setAttached(false)
    expect(() => f.core.play(req('a'))).toThrow(/噛んでいません/)
  })
})

describe('常駐音源の上限', () => {
  it(`${PRELOAD_MAX} 件を超えたら古い順に落とす`, () => {
    const f = fake()
    for (let i = 0; i <= PRELOAD_MAX; i++) f.core.preloadPcm(`s${i}`, 'x', pcm())
    expect(f.core.preloadedCount()).toBe(PRELOAD_MAX)
    // いちばん古い s0 が落ちる
    expect(f.calls).toContain('unload:s0@x')
  })

  it('鳴っている音源は落とさない（途中で音が消える）', () => {
    const f = fake()
    f.core.preloadPcm('s0', 'x', pcm())
    f.core.play(req('s0', 'x'))
    for (let i = 1; i <= PRELOAD_MAX; i++) f.core.preloadPcm(`s${i}`, 'x', pcm())
    expect(f.calls).not.toContain('unload:s0@x')
    // 代わりに次に古いものが落ちる
    expect(f.calls).toContain('unload:s1@x')
  })

  it('使うたびに並べ直す（LRU）', () => {
    const f = fake()
    f.core.preloadPcm('s0', 'x', pcm())
    for (let i = 1; i < PRELOAD_MAX; i++) f.core.preloadPcm(`s${i}`, 'x', pcm())
    // s0 を使い直してから溢れさせる
    f.core.preloadPcm('s0', 'x', pcm())
    f.core.preloadPcm('last', 'x', pcm())
    expect(f.calls).not.toContain('unload:s0@x')
    expect(f.calls).toContain('unload:s1@x')
  })
})

describe('hook とのズレからの復帰', () => {
  it('no source と言われたら記録を落とし、次の再生で送り直す', () => {
    const f = fake()
    f.core.preloadPcm('a', '1_2', pcm())
    const vid = f.core.play(req('a')) as string
    f.core.onHookEvent({ ev: 'playRejected', voiceId: vid, reason: 'no source: a@1_2' })
    // 記録が落ちているので、そのまま play すると断られる
    expect(() => f.core.play(req('a'))).toThrow(/hook 側にありません/)
    // 送り直せば鳴る
    expect(f.core.preloadPcm('a', '1_2', pcm()).sent).toBe(true)
  })

  it('普通に鳴り終わったときは記録を落とさない', () => {
    const f = fake()
    f.core.preloadPcm('a', '1_2', pcm())
    const vid = f.core.play(req('a')) as string
    f.core.onHookEvent({ ev: 'voiceEnded', voiceId: vid })
    expect(f.core.preloadedCount()).toBe(1)
    expect(f.core.preloadPcm('a', '1_2', pcm()).sent).toBe(false)
  })

  it('鳴り終わった voice は退避の保護から外れる', () => {
    const f = fake()
    f.core.preloadPcm('s0', 'x', pcm())
    const vid = f.core.play(req('s0', 'x')) as string
    f.core.onHookEvent({ ev: 'voiceEnded', voiceId: vid })
    for (let i = 1; i <= PRELOAD_MAX; i++) f.core.preloadPcm(`s${i}`, 'x', pcm())
    expect(f.calls).toContain('unload:s0@x')
  })
})

describe('hook のイベントをゲートへ回す', () => {
  it('activity はゲートを開閉する', () => {
    const f = fake()
    f.core.onHookEvent({ ev: 'activity', playing: true })
    expect(f.calls).toContain('gateOpen')
  })

  it('vc はゲートの在席判定へ渡る', () => {
    const f = fake()
    f.core.onHookEvent({ ev: 'activity', playing: true })
    f.core.onHookEvent({ ev: 'vc', active: false })
    expect(f.gate.isPlaying).toBe(true)
  })

  it('detached でゲートを戻し、hook 側の記録も捨てる', () => {
    const f = fake()
    f.core.preloadPcm('a', '1_2', pcm())
    f.core.onHookEvent({ ev: 'activity', playing: true })
    f.core.onHookEvent({ ev: 'detached', reason: 'process-terminated' })
    expect(f.core.preloadedCount()).toBe(0)
    expect(f.gate.isPlaying).toBe(false)
    expect(f.calls).toContain('gateClose')
  })

  it('イベントはそのまま上へ流す', () => {
    const seen: EngineEvent[] = []
    const inj = {
      get attached() {
        return true
      },
      setMaster: () => {}
    } as unknown as Injector
    const gate = new FridaGate({ gateOpen: () => {}, gateClose: () => {}, gateReset: () => {} })
    const core = createEngineCore({ inj, gate, emit: (p) => void seen.push(p) })
    core.onHookEvent({ ev: 'calib', vRms: 0.06 })
    expect(seen).toEqual([{ ev: 'calib', vRms: 0.06 }])
  })
})

describe('セッションの張り直し', () => {
  it('記録を捨てて master を入れ直す（新しい hook は 1.0 で始まる）', () => {
    const f = fake()
    f.core.setMaster(2.5)
    f.core.preloadPcm('a', '1_2', pcm())
    f.core.resetSession()
    expect(f.core.preloadedCount()).toBe(0)
    expect(f.calls.filter((c) => c === 'master:2.5')).toHaveLength(2)
  })
})
