import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '../src/ui/mockApi.js'
import { recommendSourceVolume } from '../src/ui/lib/calibration.js'
import type { Api, AppConfig, EngineEvent, SoundItem, SourceStats } from '../src/shared/types.js'

describe('UI store engine lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  it('engineLost clears stale playback but keeps the auto-reattach connection usable', async () => {
    const listeners = new Set<(event: EngineEvent) => void>()
    const api: Api = {
      ...createMockApi(),
      onEngineEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const { useStore } = await import('../src/ui/store.js')

    await useStore.getState().init()
    useStore.setState({
      attached: true,
      connection: 'connected',
      micTransmit: 'open',
      previewSrc: 'preview-source',
      voices: [
        { voiceId: 'v1', srcId: 'chime', name: 'chime', volume: 1, kind: 'vc' },
        { voiceId: 'preview', srcId: 'preview-source', name: 'preview-source', volume: 1, kind: 'preview' }
      ]
    })

    for (const listener of listeners) listener({ ev: 'engineLost', code: 9 })

    const state = useStore.getState()
    expect(state.voices).toEqual([])
    expect(state.previewSrc).toBeNull()
    expect(state.micTransmit).toBe('unknown')
    expect(state.attached).toBe(true)
    expect(state.connection).toBe('connected')

    await state.play(state.sounds[0]!.id)
    expect(useStore.getState().voices).toHaveLength(1)
    expect(useStore.getState().voices[0]?.kind).toBe('vc')
  })
})

describe('UI store normalizeAll', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  const sound = (id: string): SoundItem => ({
    id,
    name: `${id}.wav`,
    path: `C:/sounds/${id}.wav`,
    fp: `fp-${id}`,
    kind: 'file'
  })

  // sourceStats の解決を手で進められる api。saveConfig に渡された内容を記録する。
  async function setup(): Promise<{
    useStore: (typeof import('../src/ui/store.js'))['useStore']
    saves: Partial<AppConfig>[]
    pending: { path: string; ok: (v: SourceStats) => void; ng: (e: unknown) => void }[]
  }> {
    const saves: Partial<AppConfig>[] = []
    const pending: { path: string; ok: (v: SourceStats) => void; ng: (e: unknown) => void }[] = []
    const api: Api = {
      ...createMockApi(),
      saveConfig: async (partial) => {
        saves.push(partial)
      },
      sourceStats: (path) => new Promise<SourceStats>((ok, ng) => pending.push({ path, ok, ng }))
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const { useStore } = await import('../src/ui/store.js')
    await useStore.getState().init()
    saves.length = 0
    return { useStore, saves, pending }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('調整済みの音源も含めて全件を測って推奨音量で上書きし、基準・送信音量は動かさず、保存は 1 回', async () => {
    const { useStore, saves, pending } = await setup()
    useStore.setState({
      sounds: [sound('a'), sound('manual'), sound('b')],
      sourceVolumes: { manual: 0.3 }
    })
    const before = useStore.getState().settings

    const job = useStore.getState().normalizeAll()
    await flush()
    // 手で決めた音源も測る
    expect(pending.map((p) => p.path)).toEqual(['C:/sounds/a.wav', 'C:/sounds/manual.wav', 'C:/sounds/b.wav'])
    expect(useStore.getState().normalizeJob).toEqual({ done: 0, total: 3 })
    pending[0]!.ok({ rms: 0.05, peak: 0.3, samples: 1, activeRatio: 1 })
    await flush()
    expect(useStore.getState().normalizeJob).toEqual({ done: 1, total: 3 })
    pending[1]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    pending[2]!.ok({ rms: 0.2, peak: 0.6, samples: 1, activeRatio: 1 })
    await job

    const st = useStore.getState()
    const ref = before.normalizeRefDbfs
    expect(st.sourceVolumes).toEqual({
      manual: recommendSourceVolume(0.1, 0.5, ref).vol,
      a: recommendSourceVolume(0.05, 0.3, ref).vol,
      b: recommendSourceVolume(0.2, 0.6, ref).vol
    })
    expect(st.sourceVolumes.manual).not.toBe(0.3)
    expect(st.settings.normalizeRefDbfs).toBe(ref)
    expect(st.settings.master).toBe(before.master)
    expect(saves).toEqual([{ sourceVolumes: st.sourceVolumes }])
    expect(st.normalizeJob).toBeNull()
    expect(st.status).toBe('3 件の音量を揃えました')
  })

  it('実行中にもう一度呼んでも受け付けない', async () => {
    const { useStore, pending } = await setup()
    useStore.setState({ sounds: [sound('a')], sourceVolumes: {} })

    const first = useStore.getState().normalizeAll()
    await flush()
    const second = useStore.getState().normalizeAll()
    await flush()
    expect(pending).toHaveLength(1)
    pending[0]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    await Promise.all([first, second])
    expect(useStore.getState().normalizeJob).toBeNull()
  })

  it('測れなかった件数と理由を伝え、測れた分は揃える', async () => {
    const { useStore, saves, pending } = await setup()
    useStore.setState({ sounds: [sound('a'), sound('b')], sourceVolumes: {} })

    const job = useStore.getState().normalizeAll()
    await flush()
    pending[0]!.ng(new Error('ffmpeg failed'))
    pending[1]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    await job

    const st = useStore.getState()
    expect(Object.keys(st.sourceVolumes)).toEqual(['b'])
    expect(saves).toHaveLength(1)
    expect(st.status).toBe('1 件の音量を揃えました。1 件を測定できませんでした: a: Error: ffmpeg failed')
  })

  it('測り始めてから手で変えた音量は上書きしない(開始前の値は上書きする)', async () => {
    const { useStore, saves, pending } = await setup()
    useStore.setState({
      sounds: [sound('a'), sound('b'), sound('c')],
      sourceVolumes: { a: 0.4, c: 0.7 }
    })

    const job = useStore.getState().normalizeAll()
    await flush()
    // a は調整済みの値から、b は未調整から、測定中に手で変える。c は触らない
    useStore.getState().setSourceVolume('a', 0.25)
    useStore.getState().setSourceVolume('b', 0.5)
    saves.length = 0
    pending[0]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    pending[1]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    pending[2]!.ok({ rms: 0.2, peak: 0.6, samples: 1, activeRatio: 1 })
    await job

    const st = useStore.getState()
    const ref = st.settings.normalizeRefDbfs
    expect(st.sourceVolumes).toEqual({ a: 0.25, b: 0.5, c: recommendSourceVolume(0.2, 0.6, ref).vol })
    expect(saves).toEqual([{ sourceVolumes: st.sourceVolumes }])
    expect(st.status).toBe('1 件の音量を揃えました。測っている間に音量が変更された 2 件はそのままにしました')
  })

  it('測っている間に一覧が再読込されて差し替わった/消えた音源には書かず、件数を伝える', async () => {
    const { useStore, saves, pending } = await setup()
    useStore.setState({ sounds: [sound('a'), sound('b')], sourceVolumes: { a: 0.4 } })

    const job = useStore.getState().normalizeAll()
    await flush()
    // a は同じ id のまま中身が差し替わり(fp が変わる)、b は一覧から消える
    useStore.setState({ sounds: [{ ...sound('a'), fp: 'fp-a-new' }] })
    pending[0]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    pending[1]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    await job

    const st = useStore.getState()
    expect(st.sourceVolumes).toEqual({ a: 0.4 })
    expect(saves).toHaveLength(0)
    expect(st.normalizeJob).toBeNull()
    expect(st.status).toBe('一覧が更新されたため 2 件は揃えませんでした。もう一度押してください')
  })

  it('音量の書き込みで例外が出ても進捗を消し、理由を伝える', async () => {
    const { useStore, pending } = await setup()
    useStore.setState({
      sounds: [sound('a')],
      sourceVolumes: {},
      setSourceVolumeLive: () => {
        throw new Error('boom')
      }
    })

    const job = useStore.getState().normalizeAll()
    await flush()
    pending[0]!.ok({ rms: 0.1, peak: 0.5, samples: 1, activeRatio: 1 })
    await expect(job).resolves.toBeUndefined()

    const st = useStore.getState()
    expect(st.normalizeJob).toBeNull()
    expect(st.status).toBe('音量を揃えられませんでした: Error: boom')
  })

  it('音源が無ければ測らずにそう伝える', async () => {
    const { useStore, saves, pending } = await setup()
    useStore.setState({ sounds: [], sourceVolumes: {} })

    await useStore.getState().normalizeAll()

    expect(pending).toHaveLength(0)
    expect(saves).toHaveLength(0)
    expect(useStore.getState().normalizeJob).toBeNull()
    expect(useStore.getState().status).toBe('音源がありません')
  })
})
