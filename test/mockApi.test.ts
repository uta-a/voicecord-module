import { describe, expect, it, vi } from 'vitest'
import { createMockApi } from '../src/ui/mockApi.js'
import type { EngineEvent } from '../src/shared/types.js'

/**
 * エンジンのモック。M1 の UI はここだけを相手にしているので、
 * 「もっともらしい値が返る」ことと「イベントが対で飛ぶ」ことを押さえる。
 * 実装が入ったら差し替えるが、それまではこれが UI の唯一の入力になる。
 */

describe('createMockApi', () => {
  it('サウンド一覧と設定を返す', async () => {
    const api = createMockApi()
    const cfg = await api.getConfig()
    expect(cfg.folder).not.toBe('')
    expect(cfg.master).toBeGreaterThan(0)

    const sounds = await api.scanFolder(cfg.folder)
    expect(sounds.length).toBeGreaterThan(0)
    // fp は内容指紋。UI は PCM のキャッシュキーに使うので、音源ごとに違う必要がある
    expect(new Set(sounds.map((s) => s.fp)).size).toBe(sounds.length)
  })

  it('サウンドボードの取得は、ID 由来の指紋と一緒にパスを返す', async () => {
    const api = createMockApi()
    const got = await api.fetchSoundboardSound('123')
    expect(got.fp).toBe('sb-123')
    expect(got.path).toMatch(/123\.ogg$/)
    expect((await api.getPcm(got.path)).byteLength).toBeGreaterThan(0)
  })

  it('saveConfig した値が getConfig に反映される', async () => {
    const api = createMockApi()
    await api.saveConfig({ master: 2.5, entrySoundEnabled: true })
    const cfg = await api.getConfig()
    expect(cfg.master).toBe(2.5)
    expect(cfg.entrySoundEnabled).toBe(true)
  })

  it('attach すると VC 在席とゲート情報が届く（UI が connected まで進む）', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi()
      const seen: EngineEvent[] = []
      api.onEngineEvent((p) => seen.push(p))
      await api.attach('canary')
      await vi.advanceTimersByTimeAsync(500)
      expect(seen.map((e) => e.ev)).toEqual(['vc', 'gateInfo'])
      expect(seen[0]!['active']).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('play した音は必ず voiceEnded で終わる（再生中一覧に溜め残さない）', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi()
      const ended: string[] = []
      api.onEngineEvent((p) => {
        if (p.ev === 'voiceEnded') ended.push(String(p['voiceId']))
      })
      const vid = await api.play({ srcId: '拍手', path: 'C:/x/拍手.wav', fp: 'mock1_1', vol: 1 })
      expect(vid).not.toBeNull()
      await vi.advanceTimersByTimeAsync(5000)
      expect(ended).toEqual([vid])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopAll で鳴っている音がすべて止まる', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi()
      const ended: string[] = []
      api.onEngineEvent((p) => {
        if (p.ev === 'voiceEnded') ended.push(String(p['voiceId']))
      })
      const a = await api.play({ srcId: 'a', path: 'a', fp: 'mock1_1', vol: 1 })
      const b = await api.play({ srcId: 'b', path: 'b', fp: 'mock2_2', vol: 1 })
      await api.stopAll()
      expect(ended.sort()).toEqual([a, b].sort())
      // 停止済みのぶんが後からもう一度飛ばないこと
      ended.length = 0
      await vi.advanceTimersByTimeAsync(5000)
      expect(ended).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('calibStart は途中経過を出して calibDone で終わる', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi()
      const evs: EngineEvent[] = []
      api.onEngineEvent((p) => evs.push(p))
      await api.calibStart('voice', 100)
      await vi.advanceTimersByTimeAsync(2000)
      expect(evs.filter((e) => e.ev === 'calib').length).toBeGreaterThan(0)
      const done = evs.filter((e) => e.ev === 'calibDone')
      expect(done).toHaveLength(1)
      // store.ts は vBlocks から確定値を測り直すので、無いと暫定値のまま扱われる
      expect(Array.isArray(done[0]!['vBlocks'])).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('getPcm は 48k / mono / f32 の無音でない PCM を返す', async () => {
    const api = createMockApi()
    const pcm = await api.getPcm('C:/x/拍手.wav')
    const f32 = new Float32Array(pcm)
    expect(f32.length).toBeGreaterThan(48000 * 0.5)
    expect(f32.some((v) => Math.abs(v) > 0.1)).toBe(true)
  })

  it('onEngineEvent の戻り値で購読を解除できる', async () => {
    const api = createMockApi()
    const seen: EngineEvent[] = []
    const off = api.onEngineEvent((p) => seen.push(p))
    off()
    await api.openGate(1000)
    expect(seen).toEqual([])
  })
})
