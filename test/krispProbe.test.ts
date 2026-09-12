import { describe, expect, it } from 'vitest'
import { interpret, snapRate } from '../src/engine/injector.js'

/**
 * Krisp のフレーム長とレートの読み取り。
 *
 * ここを間違えると「遅くて低い音が鳴る」だけになり、動いているようで動いていない、
 * 一番気付きにくい壊れ方をする（実機で踏んだ）。旧解析は 480 サンプル / 48kHz と
 * 書いていたが、Canary 1.0.1169 では 320 サンプル / 32kHz だった。
 */

describe('snapRate', () => {
  it('よくあるレートの近傍は丸める（端数のまま扱うと診断が読みにくい）', () => {
    expect(snapRate(31857)).toBe(32000)
    expect(snapRate(32143)).toBe(32000)
    expect(snapRate(47900)).toBe(48000)
    expect(snapRate(15873)).toBe(16000)
  })

  it('どれにも寄らない値はそのまま整数で返す', () => {
    expect(snapRate(20000)).toBe(20000)
    expect(snapRate(36000.4)).toBe(36000)
  })

  it('44100 と 48000 を取り違えない（許容幅が広すぎないこと）', () => {
    expect(snapRate(44100)).toBe(44100)
    expect(snapRate(48000)).toBe(48000)
  })
})

describe('interpret', () => {
  it('krisp が無ければ found:false', () => {
    expect(interpret({ found: false })).toEqual({
      found: false,
      frameSamples: null,
      sampleRate: null
    })
    expect(interpret(undefined)).toEqual({ found: false, frameSamples: null, sampleRate: null })
  })

  it('実機で観測した値からレートを出す（320 サンプル × 100Hz = 32000）', () => {
    const r = interpret({ found: true, calls: 71, elapsedMs: 700, counts: { '320': 71 } })
    expect(r.found).toBe(true)
    expect(r.frameSamples).toBe(320)
    expect(r.sampleRate).toBe(32000)
  })

  it('旧解析の値でも同じ式で 48000 になる（480 サンプル × 100Hz）', () => {
    const r = interpret({ found: true, calls: 71, elapsedMs: 700, counts: { '480': 71 } })
    expect(r.frameSamples).toBe(480)
    expect(r.sampleRate).toBe(48000)
  })

  it('フレーム長が揺れても最頻値を採る', () => {
    const r = interpret({
      found: true,
      calls: 101,
      elapsedMs: 1000,
      counts: { '320': 98, '160': 2, '640': 1 }
    })
    expect(r.frameSamples).toBe(320)
  })

  it('krisp は載っているが鳴っていなければ found だけ返す', () => {
    // VC に入っていない等。レートは測れないので null のまま次の attach で測り直す
    expect(interpret({ found: true, calls: 0, elapsedMs: 0, counts: {} })).toEqual({
      found: true,
      frameSamples: null,
      sampleRate: null
    })
  })

  it('1 回しか発火していなければレートを名乗らない（区間が作れない）', () => {
    const r = interpret({ found: true, calls: 1, elapsedMs: 700, counts: { '320': 1 } })
    expect(r.frameSamples).toBe(320)
    expect(r.sampleRate).toBeNull()
  })

  it('経過時間が 0 ならレートを名乗らない（0 除算にしない）', () => {
    const r = interpret({ found: true, calls: 10, elapsedMs: 0, counts: { '320': 10 } })
    expect(r.sampleRate).toBeNull()
  })
})
