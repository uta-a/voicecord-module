import { beforeEach, describe, expect, it } from 'vitest'
import {
  SCAN_CONCURRENCY,
  clearSourceStatsCache,
  scanSources,
  type ScanProgress
} from '../src/ui/lib/sourceScan.js'
import type { SoundItem, SourceStats } from '../src/shared/types.js'

function sound(i: number): SoundItem {
  return { id: `s${i}`, name: `s${i}.wav`, path: `C:/sounds/s${i}.wav`, fp: `fp${i}`, kind: 'file' }
}

function statsFor(path: string): SourceStats {
  return { rms: 0.1, peak: 0.5, samples: path.length, activeRatio: 1 }
}

// 呼ばれた順に解決を手で進められる sourceStats。同時に何本走っているかを数える。
function deferredApi(): {
  api: { sourceStats: (path: string) => Promise<SourceStats> }
  calls: string[]
  inflight: () => number
  maxInflight: () => number
  resolveNext: () => Promise<void>
  rejectNext: (e: unknown) => Promise<void>
} {
  const calls: string[] = []
  const pending: { path: string; ok: (v: SourceStats) => void; ng: (e: unknown) => void }[] = []
  let running = 0
  let peak = 0
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return {
    api: {
      sourceStats: (path) => {
        calls.push(path)
        running++
        peak = Math.max(peak, running)
        return new Promise<SourceStats>((ok, ng) => pending.push({ path, ok, ng })).finally(() => {
          running--
        })
      }
    },
    calls,
    inflight: () => running,
    maxInflight: () => peak,
    resolveNext: async () => {
      const p = pending.shift()!
      p.ok(statsFor(p.path))
      await flush()
    },
    rejectNext: async (e) => {
      pending.shift()!.ng(e)
      await flush()
    }
  }
}

describe('scanSources', () => {
  beforeEach(() => {
    clearSourceStatsCache()
  })

  it('同時に走らせる測定は SCAN_CONCURRENCY 本までで、全件の結果を fp で返す', async () => {
    const d = deferredApi()
    const sounds = Array.from({ length: 7 }, (_, i) => sound(i))
    const progress: ScanProgress[] = []
    const job = scanSources(sounds, d.api, (p) => progress.push(p))
    await Promise.resolve()
    expect(d.inflight()).toBe(SCAN_CONCURRENCY)
    for (let i = 0; i < sounds.length; i++) await d.resolveNext()
    const r = await job
    expect(d.maxInflight()).toBe(SCAN_CONCURRENCY)
    expect(r.failed).toBe(0)
    expect(r.firstError).toBeNull()
    expect([...r.stats.keys()].sort()).toEqual(sounds.map((s) => s.fp).sort())
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(progress.every((p) => p.total === 7)).toBe(true)
  })

  it('失敗した件数と最初の理由を返し、残りは測り続ける', async () => {
    const d = deferredApi()
    const sounds = [sound(0), sound(1), sound(2)]
    const job = scanSources(sounds, d.api)
    await Promise.resolve()
    await d.rejectNext(new Error('ffmpeg failed'))
    await d.rejectNext(new Error('second'))
    await d.resolveNext()
    const r = await job
    expect(r.failed).toBe(2)
    expect(r.firstError).toEqual({ id: 's0', message: 'Error: ffmpeg failed' })
    expect([...r.stats.keys()]).toEqual(['fp2'])
  })

  it('一度測った fp は測り直さず、キャッシュを消すと測り直す', async () => {
    let n = 0
    const api = {
      sourceStats: async (path: string) => {
        n++
        return statsFor(path)
      }
    }
    const sounds = [sound(0), sound(1)]
    await scanSources(sounds, api)
    expect(n).toBe(2)
    const again = await scanSources(sounds, api)
    expect(n).toBe(2)
    expect(again.stats.size).toBe(2)
    clearSourceStatsCache()
    await scanSources(sounds, api)
    expect(n).toBe(4)
  })

  it('測定中にキャッシュを消すと、その測定の結果はキャッシュへ戻さない', async () => {
    const d = deferredApi()
    const sounds = [sound(0)]
    const job = scanSources(sounds, d.api)
    await Promise.resolve()
    clearSourceStatsCache() // 「測り直す」
    await d.resolveNext()
    const r = await job
    // 走っていた測定の結果そのものは返す
    expect(r.stats.size).toBe(1)

    // 次のスキャンでは古い結果を使わず実際に測る
    const again = scanSources(sounds, d.api)
    await Promise.resolve()
    expect(d.calls).toHaveLength(2)
    await d.resolveNext()
    await again

    // 消した後に始めた測定の結果はキャッシュされる
    await scanSources(sounds, d.api)
    expect(d.calls).toHaveLength(2)
  })

  it('取り消すと次の音源へ進まず、取り消し後に届いた結果は捨てる', async () => {
    const d = deferredApi()
    const sounds = Array.from({ length: 6 }, (_, i) => sound(i))
    const ctrl = new AbortController()
    const progress: ScanProgress[] = []
    const job = scanSources(sounds, d.api, (p) => progress.push(p), ctrl.signal)
    await Promise.resolve()
    await d.resolveNext()
    const before = progress.length
    ctrl.abort()
    await d.resolveNext()
    await d.resolveNext()
    await d.resolveNext()
    const r = await job
    // 取り消した時点で走っていた分しか呼ばれていない
    expect(d.calls).toHaveLength(SCAN_CONCURRENCY + 1)
    expect(progress).toHaveLength(before)
    expect(r.stats.size).toBe(before)
  })
})
