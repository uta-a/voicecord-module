import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '../src/ui/mockApi.js'
import { recommendSourceVolume } from '../src/ui/lib/calibration.js'
import type { Api, AppConfig, AttachResult, EngineEvent, SoundItem, SourceStats } from '../src/shared/types.js'

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

describe('UI store persistence failures', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  it('notifies on rejected config persistence without an unhandled rejection', async () => {
    const api: Api = {
      ...createMockApi(),
      saveConfig: async () => {
        throw new Error('disk full')
      }
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    // store は import 時に API を固定するため、モック後のモジュール境界を検証する。
    const { useStore } = await import('../src/ui/store.js')
    await useStore.getState().init()

    useStore.getState().setMaster(0.5)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(useStore.getState().settings.master).toBe(0.5)
    expect(useStore.getState().notice.msg).toContain('disk full')
  })
})

describe('UI store preview cache identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  it('different paths sharing a fingerprint play their own PCM, including the AudioBuffer cache', async () => {
    const played: number[] = []
    class AudioContextStub {
      state = 'running'
      destination = {}
      createBuffer(_channels: number, length: number) {
        const data = new Float32Array(length)
        return { length, data, copyToChannel: (pcm: Float32Array) => data.set(pcm) }
      }
      createBufferSource() {
        const source = {
          buffer: null as { data: Float32Array } | null,
          onended: null as (() => void) | null,
          connect: (node: unknown) => node,
          start: () => played.push(source.buffer!.data[0]!),
          stop: () => {}
        }
        return source
      }
      createGain() { return { gain: { value: 0 }, connect: (node: unknown) => node } }
      createDynamicsCompressor() {
        return {
          threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
          attack: { value: 0 }, release: { value: 0 }, connect: () => {}
        }
      }
    }
    vi.stubGlobal('AudioContext', AudioContextStub)
    const api: Api = {
      ...createMockApi(),
      getPcm: async (path) => new Float32Array([path.endsWith('a.wav') ? 0.125 : 0.75]).buffer
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    // store は import 時に API を固定するため、モック後のモジュール境界を検証する。
    const { useStore } = await import('../src/ui/store.js')
    useStore.setState({ sounds: ['a', 'b'].map((id) => ({
      id, name: id, path: `C:/sounds/${id}.wav`, fp: 'same-mtime-size', kind: 'file'
    })) })
    useStore.getState().togglePreview('a')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    useStore.getState().stopPreview()
    useStore.getState().togglePreview('b')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    useStore.getState().stopPreview()
    expect(played).toEqual([0.125, 0.75])
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

describe('UI store playSoundboardSound', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  async function setup(over: Partial<Api> = {}): Promise<{
    useStore: (typeof import('../src/ui/store.js'))['useStore']
    plays: Parameters<Api['play']>[0][]
    fetches: string[]
  }> {
    const plays: Parameters<Api['play']>[0][] = []
    const fetches: string[] = []
    const base = createMockApi()
    const api: Api = {
      ...base,
      play: async (req) => {
        plays.push(req)
        return `vid-${plays.length}`
      },
      fetchSoundboardSound: async (id) => {
        fetches.push(id)
        return { path: `C:/tmp/VoiceCord/soundboard/${id}.ogg`, fp: `sb-${id}` }
      },
      ...over
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const { useStore } = await import('../src/ui/store.js')
    await useStore.getState().init()
    // preload は設定 ON のときだけ呼ぶ。ここでは ON の状態から始める
    useStore.setState({ settings: { ...useStore.getState().settings, unlockSoundboard: true } })
    return { useStore, plays, fetches }
  }

  it('VC に接続していなければ取得も再生もせず、理由を出す', async () => {
    const { useStore, plays, fetches } = await setup()
    useStore.setState({ attached: true, connection: 'waiting', status: '' })
    await useStore.getState().playSoundboardSound('123', 'Windows Alarm')
    expect(fetches).toEqual([])
    expect(plays).toEqual([])
    expect(useStore.getState().status).toBe('VC に接続してから再生してください')
  })

  it('取得に失敗したら理由を出して鳴らさない', async () => {
    const { useStore, plays } = await setup({
      fetchSoundboardSound: async () => {
        // Electron の invoke は main の例外をこの形に包んで返す
        throw new Error("Error invoking remote method 'voicecord:fetchSoundboardSound': Error: HTTP 404")
      }
    })
    useStore.setState({ attached: true, connection: 'connected', voices: [] })
    await useStore.getState().playSoundboardSound('123', 'Windows Alarm')
    expect(plays).toEqual([])
    expect(useStore.getState().status).toBe('ほかのサーバーのサウンドを取得できませんでした: HTTP 404')
    expect(useStore.getState().voices).toEqual([])
  })

  it('取得している間に設定が OFF にされたら鳴らさず、理由を出す', async () => {
    let finish: (v: { path: string; fp: string }) => void = () => undefined
    const { useStore, plays } = await setup({
      fetchSoundboardSound: () => new Promise((resolve) => (finish = resolve))
    })
    useStore.setState({ attached: true, connection: 'connected', voices: [], status: '' })
    const job = useStore.getState().playSoundboardSound('123', 'Windows Alarm')
    useStore.setState({ settings: { ...useStore.getState().settings, unlockSoundboard: false } })
    finish({ path: 'C:/tmp/VoiceCord/soundboard/123.ogg', fp: 'sb-123' })
    await job
    expect(plays).toEqual([])
    expect(useStore.getState().voices).toEqual([])
    expect(useStore.getState().status).toContain('設定がオフ')
  })

  it('取得したパスと指紋で、音量 1.0 のまま VC へ鳴らし、表示名で行を作る', async () => {
    const { useStore, plays, fetches } = await setup()
    useStore.setState({
      attached: true,
      connection: 'connected',
      voices: [],
      status: '',
      sourceVolumes: { 'sb:123': 0.2 },
      settings: {
        ...useStore.getState().settings,
        unlockSoundboard: true,
        sidetoneEnabled: false,
        calibration: { at: 1, voiceRms: 0.1, voicePeak: 0.5, activeRatio: 1, targetDb: 0 }
      }
    })
    await useStore.getState().playSoundboardSound('123', 'Windows Alarm')
    expect(fetches).toEqual(['123'])
    expect(plays).toEqual([
      { srcId: 'sb:123', path: 'C:/tmp/VoiceCord/soundboard/123.ogg', fp: 'sb-123', vol: 1 }
    ])
    expect(useStore.getState().voices).toEqual([
      { voiceId: 'vid-1', srcId: 'sb:123', name: 'Windows Alarm', volume: 1, kind: 'vc' }
    ])
    // 音量を揃える対象ではないので、未調整の通知は出さない
    expect(useStore.getState().status).toBe('')
  })
})

describe('UI store connect', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  // attach の結果を手で返せる api。init が呼ぶ 1 回目はすぐ返し、2 回目以降は pending に積む
  async function setup(first: AttachResult): Promise<{
    useStore: (typeof import('../src/ui/store.js'))['useStore']
    emit: (p: EngineEvent) => void
    pending: Array<(r: AttachResult) => void>
  }> {
    const listeners = new Set<(event: EngineEvent) => void>()
    const pending: Array<(r: AttachResult) => void> = []
    let calls = 0
    const api: Api = {
      ...createMockApi(),
      attach: async () => {
        if (calls++ === 0) return first
        return new Promise<AttachResult>((resolve) => pending.push(resolve))
      },
      onEngineEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const { useStore } = await import('../src/ui/store.js')
    await useStore.getState().init()
    const emit = (p: EngineEvent): void => {
      for (const l of listeners) l(p)
    }
    return { useStore, emit, pending }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('attach の結果が VC 在席なら、vc の通知を待たずに接続済みにする（Ctrl+R 後は再送されない）', async () => {
    const { useStore } = await setup({ ok: true, pid: 4242, label: 'canary 1.0.1177', vcActive: true })
    expect(useStore.getState().connection).toBe('connected')
    expect(useStore.getState().attached).toBe(true)
  })

  it('attach の結果が VC 在席でなければ待機中にする', async () => {
    const { useStore } = await setup({ ok: true, pid: 4242, label: 'canary 1.0.1177', vcActive: false })
    expect(useStore.getState().connection).toBe('waiting')
  })

  it('attach を待っている間に vc:true が届いたら、結果で待機中に戻さない', async () => {
    const { useStore, emit, pending } = await setup({ ok: true, pid: 1, label: 'canary 1.0.1177', vcActive: false })
    const job = useStore.getState().connect('canary')
    await flush()
    expect(useStore.getState().connection).toBe('switching')
    expect(pending).toHaveLength(1)
    emit({ ev: 'vc', active: true })
    expect(useStore.getState().connection).toBe('connected')
    pending[0]!({ ok: true, pid: 1, label: 'canary 1.0.1177', vcActive: false })
    await job
    expect(useStore.getState().connection).toBe('connected')
    expect(useStore.getState().attached).toBe(true)
  })

  it('より新しい切替に追い越された attach の結果は、VC 在席でも反映しない', async () => {
    const { useStore, pending } = await setup({ ok: true, pid: 1, label: 'canary 1.0.1177', vcActive: false })
    const older = useStore.getState().connect('canary')
    await flush()
    const newer = useStore.getState().connect('canary')
    await flush()
    expect(pending).toHaveLength(2)
    pending[0]!({ ok: true, pid: 1, label: 'old', vcActive: true })
    await older
    expect(useStore.getState().connection).toBe('switching')
    pending[1]!({ ok: true, pid: 2, label: 'new', vcActive: false })
    await newer
    expect(useStore.getState().connection).toBe('waiting')
    expect(useStore.getState().connectionDetail).toBe('new  PID 2')
  })

  it('注入先の PID が分からなければ、接続の詳細に PID を出さない', async () => {
    const { useStore } = await setup({ ok: true, pid: null, label: 'canary 1.0.1177', vcActive: false })
    expect(useStore.getState().connectionDetail).toBe('canary 1.0.1177')
  })
})

describe('UI store Krisp の案内', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  it('Discord 上で VC に居るのに接続済みでないときだけ案内する', async () => {
    const { shouldShowKrispHint } = await import('../src/ui/store.js')
    expect(shouldShowKrispHint({ discordInVc: true, connection: 'waiting' })).toBe(true)
    expect(shouldShowKrispHint({ discordInVc: true, connection: 'disconnected' })).toBe(false)
    expect(shouldShowKrispHint({ discordInVc: true, connection: 'connected' })).toBe(false)
    expect(shouldShowKrispHint({ discordInVc: false, connection: 'waiting' })).toBe(false)
  })

  async function setup(): Promise<{
    store: typeof import('../src/ui/store.js')
    emit: (p: EngineEvent) => void
  }> {
    const listeners = new Set<(event: EngineEvent) => void>()
    const api: Api = {
      ...createMockApi(),
      attach: async () => ({ ok: true, pid: 1, label: 'canary 1.0.1177', vcActive: false }),
      onEngineEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const store = await import('../src/ui/store.js')
    await store.useStore.getState().init()
    // init の後から偽のタイマーにする(init の中の待ちを止めない)
    vi.useFakeTimers()
    const emit = (p: EngineEvent): void => {
      for (const l of listeners) l(p)
    }
    return { store, emit }
  }

  it('VC に入って 5 秒たっても Krisp の処理を検出できなければ案内を出し、VC を抜けたら消す', async () => {
    const { store } = await setup()
    const { useStore, KRISP_HINT_AFTER_MS } = store
    expect(KRISP_HINT_AFTER_MS).toBe(5000)
    expect(useStore.getState().connection).toBe('waiting')
    expect(useStore.getState().krispHint).toBe(false)

    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(KRISP_HINT_AFTER_MS - 1)
    expect(useStore.getState().krispHint).toBe(false)
    vi.advanceTimersByTime(1)
    expect(useStore.getState().krispHint).toBe(true)

    useStore.getState().setDiscordInVc(false)
    expect(useStore.getState().krispHint).toBe(false)
  })

  it('入室の判定時にまだ接続中でも、connect が待機中で終わった時点で経過時間を見て案内する', async () => {
    const { store } = await setup()
    const { useStore } = store
    // Ctrl+R 後は、入室の通知が init / connect の完了より先に来る
    useStore.setState({ connection: 'switching' })
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(6000)
    expect(useStore.getState().krispHint).toBe(false)

    await useStore.getState().connect('canary')
    expect(useStore.getState().connection).toBe('waiting')
    expect(useStore.getState().krispHint).toBe(true)
  })

  it('同じ値を続けて渡しても待ち時間を数え直さない', async () => {
    const { store } = await setup()
    const { useStore } = store
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(3000)
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(2000)
    expect(useStore.getState().krispHint).toBe(true)
  })

  it('待っている間に VC を抜けたら案内しない', async () => {
    const { store } = await setup()
    const { useStore } = store
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(3000)
    useStore.getState().setDiscordInVc(false)
    vi.advanceTimersByTime(10_000)
    expect(useStore.getState().krispHint).toBe(false)
  })

  it('vc:true が届けば案内を消し、その後 vc:false になっても(ミュートの可能性があるので)案内し直さない', async () => {
    const { store, emit } = await setup()
    const { useStore } = store
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(5000)
    expect(useStore.getState().krispHint).toBe(true)

    emit({ ev: 'vc', active: true })
    expect(useStore.getState().connection).toBe('connected')
    expect(useStore.getState().krispHint).toBe(false)

    emit({ ev: 'vc', active: false })
    expect(useStore.getState().connection).toBe('waiting')
    vi.advanceTimersByTime(10_000)
    expect(useStore.getState().krispHint).toBe(false)
  })

  it('待っている間に vc:true が届いたら、待ち時間が切れても案内しない', async () => {
    const { store, emit } = await setup()
    const { useStore } = store
    useStore.getState().setDiscordInVc(true)
    vi.advanceTimersByTime(1000)
    emit({ ev: 'vc', active: true })
    emit({ ev: 'vc', active: false })
    vi.advanceTimersByTime(10_000)
    expect(useStore.getState().krispHint).toBe(false)
  })

  it('再生を断る理由は、案内中なら Krisp の案内、そうでなければ従来の文言', async () => {
    const { store } = await setup()
    const { useStore, KRISP_HINT } = store
    const id = useStore.getState().sounds[0]!.id

    useStore.setState({ attached: true, connection: 'waiting', krispHint: false, status: '' })
    await useStore.getState().play(id)
    expect(useStore.getState().status).toBe('VC に接続してから再生してください')

    useStore.setState({ krispHint: true, status: '' })
    await useStore.getState().play(id)
    expect(useStore.getState().status).toBe(KRISP_HINT)
    expect(KRISP_HINT).toBe(
      'VC にいるのに Discord の音声処理（Krisp）を検出できません。設定 → 音声・ビデオ → ノイズ抑制を「Krisp」にし、マイクのミュートを解除してください'
    )
  })
})
