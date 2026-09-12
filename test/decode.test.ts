import { describe, expect, it } from 'vitest'
import { createApi, type IpcRendererLike } from '../src/preload/api.js'
import { decodeToMono, isRawF32, rawF32ToMono, toMono } from '../src/preload/decode.js'
import { CH, type VoiceCordStatus } from '../src/shared/ipc.js'
import type { SourceStats } from '../src/shared/types.js'

/**
 * デコードと renderer 側の窓口。
 *
 * ffmpeg を持ち込まない代わりに、ここが唯一のデコード経路になる。
 * 失敗したときに「一覧から黙って消える」のではなく理由が出ることを含めて見る。
 */

describe('toMono', () => {
  it('チャンネルが 1 本ならそのまま', () => {
    expect([...toMono([new Float32Array([0.1, -0.2])])]).toEqual([
      Math.fround(0.1),
      Math.fround(-0.2)
    ])
  })

  it('複数チャンネルは平均する（片方だけ取ると位相差で音量が体感とずれる）', () => {
    const out = toMono([new Float32Array([1, 0]), new Float32Array([0, 1])])
    expect([...out]).toEqual([0.5, 0.5])
  })

  it('長さが違っても短い方に引きずられて落ちない', () => {
    const out = toMono([new Float32Array([1, 1]), new Float32Array([1])])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(1)
    expect(out[1]).toBe(0.5)
  })

  it('空なら空', () => {
    expect(toMono([])).toHaveLength(0)
  })
})

describe('生 f32', () => {
  it('.f32 は拡張子で見分ける（大文字も）', () => {
    expect(isRawF32('a.f32')).toBe(true)
    expect(isRawF32('a.F32')).toBe(true)
    expect(isRawF32('a.wav')).toBe(false)
  })

  it('デコードせずそのまま読む', () => {
    const src = new Float32Array([0.25, -0.5])
    expect([...rawF32ToMono(src.buffer)]).toEqual([0.25, -0.5])
  })

  it('4 の倍数でないファイルは端数を捨てる（走査ごと落とさない）', () => {
    const bytes = new ArrayBuffer(9)
    expect(rawF32ToMono(bytes)).toHaveLength(2)
  })
})

describe('decodeToMono', () => {
  it('.f32 はデコーダを呼ばない', async () => {
    let called = 0
    const src = new Float32Array([1, 0])
    const out = await decodeToMono(src.buffer, 'x.f32', async () => {
      called += 1
      return []
    })
    expect(called).toBe(0)
    expect([...out]).toEqual([1, 0])
  })

  it('それ以外はデコーダを通してモノラルにする', async () => {
    const out = await decodeToMono(new ArrayBuffer(4), 'x.wav', async () => [
      new Float32Array([1, 1]),
      new Float32Array([0, 0])
    ])
    expect([...out]).toEqual([0.5, 0.5])
  })

  it('デコードできない形式は理由つきで投げる（.wma を黙って消さない）', async () => {
    await expect(
      decodeToMono(new ArrayBuffer(4), 'x.wma', async () => {
        throw new Error('Unable to decode audio data')
      })
    ).rejects.toThrow(/この形式は再生できません（x\.wma）/)
  })

  it('チャンネルが 1 本も無ければ投げる', async () => {
    await expect(decodeToMono(new ArrayBuffer(4), 'x.wav', async () => [])).rejects.toThrow(
      /音声が入っていません/
    )
  })
})

const STATUS: VoiceCordStatus = {
  engine: 'attached',
  attachedPid: 4242,
  enginePid: null,
  discordBuild: 'canary',
  discordVersion: '1.0.1165',
  lastError: null,
  degraded: []
}

interface FakeIpc extends IpcRendererLike {
  calls: Array<{ ch: string; args: unknown[] }>
  push(payload: unknown): void
}

function fakeIpc(results: Record<string, unknown> = {}): FakeIpc {
  const calls: Array<{ ch: string; args: unknown[] }> = []
  const listeners: Array<(e: unknown, ...a: unknown[]) => void> = []
  return {
    calls,
    invoke: async (ch, ...args) => {
      calls.push({ ch, args })
      if (ch in results) return results[ch]
      if (ch === CH.getStatus || ch === CH.subscribe || ch === CH.reattach) return STATUS
      return undefined
    },
    on: (_ch, l) => void listeners.push(l),
    removeListener: (_ch, l) => {
      const i = listeners.indexOf(l)
      if (i >= 0) listeners.splice(i, 1)
    },
    push: (payload) => {
      for (const l of [...listeners]) l(null, payload)
    }
  }
}

/** 2ch のステレオを返すデコーダ */
const stereo = async (): Promise<Float32Array[]> => [
  new Float32Array([1, 0]),
  new Float32Array([1, 0])
]

describe('createApi', () => {
  it('getPcm は生ファイルを取り寄せてデコードする', async () => {
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8) })
    const api = createApi(ipc, stereo)
    const buf = await api.getPcm('C:/sounds/a.wav')
    expect(ipc.calls[0]).toEqual({ ch: CH.readSoundFile, args: ['C:/sounds/a.wav'] })
    expect([...new Float32Array(buf)]).toEqual([1, 0])
  })

  it('play は PCM を先に渡してから鳴らす（順序が逆だと engine が音を持っていない）', async () => {
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8), [CH.play]: 'v1' })
    const api = createApi(ipc, stereo)
    const vid = await api.play({ srcId: 'a', path: 'C:/sounds/a.wav', fp: '1_2', vol: 1 })
    expect(vid).toBe('v1')
    expect(ipc.calls.map((c) => c.ch)).toEqual([CH.readSoundFile, CH.preloadPcm, CH.play])
    expect(ipc.calls[1]?.args.slice(0, 2)).toEqual(['a', '1_2'])
  })

  it('attach は健全なエンジンを起こし直さない（Ctrl+R のたびに殺さない）', async () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    expect(await api.attach('canary')).toEqual({
      ok: true,
      pid: 4242,
      label: 'canary 1.0.1165'
    })
    expect(ipc.calls.map((c) => c.ch)).toEqual([CH.getStatus])
  })

  it('エンジンが落ちているときだけ起こし直す', async () => {
    const dead = { ...STATUS, engine: 'failed' as const, attachedPid: null }
    const ipc = fakeIpc({ [CH.getStatus]: dead, [CH.reattach]: dead })
    const r = await createApi(ipc, stereo).attach('canary')
    expect(r.ok).toBe(false)
    expect(ipc.calls.map((c) => c.ch)).toEqual([CH.getStatus, CH.reattach])
  })

  it('starting の間は落ち着くまで待つ（PID null で「見つからず」に見せない）', async () => {
    let n = 0
    const ipc = fakeIpc()
    const orig = ipc.invoke
    ipc.invoke = async (ch, ...args) => {
      if (ch === CH.getStatus && n++ < 2) {
        await orig(ch, ...args)
        return { ...STATUS, engine: 'starting' as const, attachedPid: null }
      }
      return orig(ch, ...args)
    }
    const r = await createApi(ipc, stereo).attach('canary')
    expect(r.pid).toBe(4242)
    expect(ipc.calls.filter((c) => c.ch === CH.getStatus).length).toBe(3)
  })

  it('listBuilds は今寄生しているビルドだけを返す', async () => {
    expect(await createApi(fakeIpc(), stereo).listBuilds()).toEqual(['canary'])
  })

  it('sourceStats はデコード結果から測る', async () => {
    const loud = new Float32Array(4800).fill(0.5)
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8) })
    const api = createApi(ipc, async () => [loud])
    const st = (await api.sourceStats('C:/sounds/a.wav')) as SourceStats
    expect(st.samples).toBe(4800)
    expect(st.peak).toBeCloseTo(0.5, 5)
    expect(st.rms).toBeCloseTo(0.5, 5)
    expect(st.activeRatio).toBe(1)
  })

  it('無音は activeRatio 0（0 除算にしない）', async () => {
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8) })
    const api = createApi(ipc, async () => [new Float32Array(0)])
    expect((await api.sourceStats('a.wav')).activeRatio).toBe(0)
  })

  it('onEngineEvent はエンジン由来のイベントだけを渡す', () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    const seen: unknown[] = []
    api.onEngineEvent((p) => seen.push(p))
    ipc.push({ ev: 'engine', payload: { ev: 'vc', active: true } })
    ipc.push({ ev: 'status', status: STATUS })
    ipc.push({ ev: 'log', level: 'info', message: 'x' })
    expect(seen).toEqual([{ ev: 'vc', active: true }])
  })

  it('onEngineEvent の戻り値で購読を解除できる', () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    const seen: unknown[] = []
    const off = api.onEngineEvent((p) => seen.push(p))
    off()
    ipc.push({ ev: 'engine', payload: { ev: 'vc', active: true } })
    expect(seen).toEqual([])
  })

  it('設定と再生の呼び口が正しいチャンネルに乗る', async () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    await api.saveConfig({ master: 2 })
    await api.setMaster(2)
    await api.stop('v1')
    await api.stopAll()
    await api.setVoiceVolume('v1', 0.5)
    await api.openGate(1500)
    await api.calibStart('voice', 300)
    await api.calibStop()
    await api.detach()
    expect(ipc.calls.map((c) => c.ch)).toEqual([
      CH.saveConfig,
      CH.setMaster,
      CH.stop,
      CH.stopAll,
      CH.setVoiceVolume,
      CH.openGate,
      CH.calibStart,
      CH.calibStop,
      CH.detach
    ])
  })
})
