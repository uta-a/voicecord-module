import { describe, expect, it, vi } from 'vitest'
import { createApi, type IpcRendererLike } from '../src/preload/api.js'
import type { AudioDecoder } from '../src/preload/decode.js'
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
  sampleRate: null,
  frameSamples: null,
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

/** 2ch のステレオを返すデコーダ工場。要求されたレートを記録する */
function stereoAt(seen?: number[]): (rate: number) => AudioDecoder {
  return (rate) => {
    seen?.push(rate)
    return async () => [new Float32Array([1, 0]), new Float32Array([1, 0])]
  }
}
const stereo = stereoAt()

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
    // レートが未取得なので、最初の 1 回だけ getStatus を聞きに行く
    expect(ipc.calls.map((c) => c.ch)).toEqual([
      CH.getStatus,
      CH.readSoundFile,
      CH.preloadPcm,
      CH.play
    ])
    // engine はレートも音源キーに含めるので、デコードしたレートを一緒に渡す
    expect(ipc.calls[2]?.args.slice(0, 3)).toEqual(['a', '1_2', 32000])
    expect(ipc.calls[3]?.args[0]).toMatchObject({ srcId: 'a', fp: '1_2', sampleRate: 32000 })
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
    const api = createApi(ipc, () => async () => [loud])
    const st = (await api.sourceStats('C:/sounds/a.wav')) as SourceStats
    expect(st.samples).toBe(4800)
    expect(st.peak).toBeCloseTo(0.5, 5)
    expect(st.rms).toBeCloseTo(0.5, 5)
    expect(st.activeRatio).toBe(1)
  })

  it('無音は activeRatio 0（0 除算にしない）', async () => {
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8) })
    const api = createApi(ipc, () => async () => [new Float32Array(0)])
    expect((await api.sourceStats('a.wav')).activeRatio).toBe(0)
  })

  it('試聴は 48000、注入は実測レートでデコードする', async () => {
    const seen: number[] = []
    const ipc = fakeIpc({
      [CH.readSoundFile]: new ArrayBuffer(8),
      [CH.play]: 'v1',
      [CH.getStatus]: { ...STATUS, sampleRate: 32000, frameSamples: 320 }
    })
    const api = createApi(ipc, stereoAt(seen))
    await api.getPcm('a.wav')
    await api.play({ srcId: 'a', path: 'a.wav', fp: '1_2', vol: 1 })
    expect(seen).toEqual([48000, 32000])
  })

  it('レートが測れない Canary は既知の 32000 で進む', async () => {
    const seen: number[] = []
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8), [CH.play]: 'v1' })
    const api = createApi(ipc, stereoAt(seen))
    await api.play({ srcId: 'a', path: 'a.wav', fp: '1_2', vol: 1 })
    expect(seen).toEqual([32000])
  })

  it('レート未計測でもフレーム長から注入レートを補完する', async () => {
    const seen: number[] = []
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8), [CH.play]: 'v1', [CH.getStatus]: { ...STATUS, sampleRate: null, frameSamples: 320 } })
    const api = createApi(ipc, stereoAt(seen))
    await api.play({ srcId: 'a', path: 'a.wav', fp: '1_2', vol: 1 })
    expect(seen).toEqual([32000])
  })

  it('状態イベントで注入レートに追随する（再アタッチで変わりうる）', async () => {
    const seen: number[] = []
    const ipc = fakeIpc({ [CH.readSoundFile]: new ArrayBuffer(8), [CH.play]: 'v1' })
    const api = createApi(ipc, stereoAt(seen))
    // 購読を開始してから状態が届く
    api.onEvent(() => {})
    ipc.push({ ev: 'status', status: { ...STATUS, sampleRate: 16000, frameSamples: 160 } })
    await api.play({ srcId: 'a', path: 'a.wav', fp: '1_2', vol: 1 })
    expect(seen).toEqual([16000])
    // getStatus を聞きに行っていないこと（イベントで足りている）
    expect(ipc.calls.some((c) => c.ch === CH.getStatus)).toBe(false)
  })

  it('VC 入室直後でレート未計測でも、play を数秒待たせない（後からまとめて鳴らさない）', async () => {
    vi.useFakeTimers()
    try {
      const seen: number[] = []
      const ipc = fakeIpc({
        [CH.readSoundFile]: new ArrayBuffer(8),
        [CH.play]: 'v1',
        // attach 済みだが Discord の音声処理がまだ測れていない
        [CH.getStatus]: { ...STATUS, enginePid: 5000, sampleRate: null, frameSamples: null }
      })
      const api = createApi(ipc, stereoAt(seen))
      const settled: string[] = []
      for (const id of ['a', 'b', 'c']) {
        void api.play({ srcId: id, path: `${id}.wav`, fp: '1_2', vol: 1 }).then(
          () => settled.push(id),
          () => settled.push(id)
        )
      }
      // クリックへの反応として許せる程度の時間だけ進める
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toEqual(['a', 'b', 'c'])
      // クリック順に engine へ届き、Canary の既定レートでデコードしている
      expect(ipc.calls.filter((c) => c.ch === CH.play).map((c) => c.args[0])).toMatchObject([
        { srcId: 'a', sampleRate: 32000 },
        { srcId: 'b', sampleRate: 32000 },
        { srcId: 'c', sampleRate: 32000 }
      ])
      expect(seen).toEqual([32000, 32000, 32000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('既定レートで鳴らした後にレートが測れたら、そのレートでデコードして送り直す', async () => {
    const seen: number[] = []
    const ipc = fakeIpc({
      [CH.readSoundFile]: new ArrayBuffer(8),
      [CH.play]: 'v1',
      // 既定（Canary = 32000）と違うレートが後から測れる状況を作るため、状態は未計測にしておく
      [CH.getStatus]: { ...STATUS, sampleRate: null, frameSamples: null }
    })
    const api = createApi(ipc, stereoAt(seen))
    const req = { srcId: 'a', path: 'a.wav', fp: '1_2', vol: 1 }
    await api.play(req)
    ipc.push({ ev: 'status', status: { ...STATUS, enginePid: 5000, sampleRate: 48000, frameSamples: 480 } })
    await api.play(req)

    expect(seen).toEqual([32000, 48000])
    const preloads = ipc.calls.filter((c) => c.ch === CH.preloadPcm).map((c) => c.args.slice(0, 3))
    expect(preloads).toEqual([
      ['a', '1_2', 32000],
      ['a', '1_2', 48000]
    ])
    const plays = ipc.calls.filter((c) => c.ch === CH.play).map((c) => c.args[0])
    expect(plays).toMatchObject([{ sampleRate: 32000 }, { sampleRate: 48000 }])
  })

  it('エンジン再起動後は直前のマスター音量を再適用する', async () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    await api.setMaster(2.03)
    ipc.calls.length = 0

    ipc.push({ ev: 'status', status: { ...STATUS, engine: 'failed', enginePid: null } })
    ipc.push({ ev: 'status', status: { ...STATUS, enginePid: 5000 } })
    ipc.push({ ev: 'status', status: { ...STATUS, enginePid: 5000, sampleRate: 32000 } })
    await Promise.resolve()

    expect(ipc.calls).toEqual([{ ch: CH.setMaster, args: [2.03] }])
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

  it('設定を保存すると、preload 側の購読者に保存した差分を渡す', async () => {
    const ipc = fakeIpc()
    const api = createApi(ipc, stereo)
    const seen: unknown[] = []
    const off = api.onConfigSaved((p) => seen.push(p))
    await api.saveConfig({ hideCameraButton: true })
    off()
    await api.saveConfig({ hideCameraButton: false })
    expect(seen).toEqual([{ hideCameraButton: true }])
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
    await api.fetchSoundboardSound('123')
    expect(ipc.calls.map((c) => c.ch)).toEqual([
      CH.saveConfig,
      CH.setMaster,
      CH.stop,
      CH.stopAll,
      CH.setVoiceVolume,
      CH.openGate,
      CH.calibStart,
      CH.calibStop,
      CH.detach,
      CH.fetchSoundboardSound
    ])
    expect(ipc.calls.at(-1)?.args).toEqual(['123'])
  })
})
