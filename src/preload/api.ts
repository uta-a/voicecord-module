import { CH, type VoiceCordEvent, type VoiceCordStatus } from '../shared/ipc.js'
import { measureSamples } from '../shared/loudness.js'
import type {
  Api,
  AppConfig,
  AttachResult,
  BuildKey,
  EngineEvent,
  InjectPlayReq,
  LoadedConfig,
  PlayReq,
  SoundItem,
  SourceStats
} from '../shared/types.js'
import {
  createOfflineDecoder,
  decodeToMono,
  PREVIEW_SAMPLE_RATE,
  type AudioDecoder
} from './decode.js'

/**
 * renderer 側の窓口。
 *
 * isolated world の window は Discord のページとは別物なので、`window.api = api`
 * と書くだけで済む。contextBridge すら要らず、しかも Discord のスクリプトや
 * 他の mod からは触れない。contextBridge で露出するより厳密に閉じている。
 *
 * デコードはここで行う。main へ生ファイルを要求し、renderer の
 * `decodeAudioData` で mono / f32 にする。ffmpeg を持ち込まずに済み、
 * store.ts の `getPcm` の呼び口は無改造のまま使える。
 *
 * **レートは 2 つある。** 試聴とラウドネス計測は 48000（`localAudio.ts` が
 * その前提で AudioBuffer を作る）。注入用は hook が実際に消費するレートで、
 * これは実測値（Canary 1.0.1169 では 32000）。混ぜると「遅くて低い音が鳴る」
 * か「試聴だけ速い」のどちらかになる。
 */

/** attach の結果が落ち着くまで待つ回数と間隔（合計 3 秒） */
export const ATTACH_SETTLE_TRIES = 20
export const ATTACH_SETTLE_INTERVAL_MS = 150
/**
 * 注入レートが未計測のときに待つ回数と間隔（合計 300ms）。
 * 長く待つとその間のクリックが溜まり、計測と同時に一斉に鳴る。
 * 待ち切れなければビルド既定で進み、計測後は engine がレート別に送り直す
 */
const RATE_WAIT_TRIES = 3
const RATE_WAIT_INTERVAL_MS = 100

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

/**
 * store.ts が見る `Api` に、VoiceCord 固有の 3 つを足したもの。
 * 前者はエンジンの操作、後者は「mod 自身が健在か」を見るためのもので層が違う。
 */
export interface VoiceCordApi extends Api {
  getStatus(): Promise<VoiceCordStatus>
  /** 購読を始めて、その時点の状態を受け取る */
  subscribe(): Promise<VoiceCordStatus>
  /** 戻り値を呼ぶと購読を解除する */
  onEvent(cb: (e: VoiceCordEvent) => void): () => void
  /** UI が設定を保存したら、保存した差分を preload 側(接ぎ木など)へ知らせる。戻り値で解除 */
  onConfigSaved(cb: (partial: Partial<AppConfig>) => void): () => void
}

export function createApi(
  ipc: IpcRendererLike,
  makeDecoder: (sampleRate: number) => AudioDecoder = createOfflineDecoder
): VoiceCordApi {
  const call = <T>(ch: string, ...args: unknown[]): Promise<T> => ipc.invoke(ch, ...args) as Promise<T>

  /** UI と preload は同じ isolated world にいるので、保存の呼び口で直接知らせる */
  const configListeners = new Set<(partial: Partial<AppConfig>) => void>()

  /** 実測された注入レート。状態が届くまでは分からない */
  let injectRate: number | null = null
  /** engine 再起動後に戻す、直前の送信マスター音量。 */
  let master: number | null = null
  let masterEnginePid: number | null = null

  const rateFromFrame = (frameSamples: number | null | undefined): number | null => {
    if (!Number.isInteger(frameSamples) || frameSamples === undefined || frameSamples === null) return null
    const inferred = frameSamples * 100
    return inferred >= 8000 && inferred <= 192000 ? inferred : null
  }

  const fallbackRateForBuild = (build: string | undefined): number =>
    build === 'canary' ? 32000 : PREVIEW_SAMPLE_RATE

  /**
   * 注入に使うレート。状態から取れなければ getStatus で聞きに行き、ごく短時間だけ待つ。
   * それでも取れなければビルド既定で進む（黙って止めるよりは鳴らす）。
   */
  const rateForInject = async (): Promise<number> => {
    if (injectRate !== null) return injectRate
    try {
      let s = await call<VoiceCordStatus>(CH.getStatus)
      for (
        let i = 0;
        i < RATE_WAIT_TRIES && s.engine === 'attached' && s.enginePid !== null && injectRate === null;
        i++
      ) {
        injectRate = s.sampleRate ?? rateFromFrame(s.frameSamples)
        if (injectRate !== null) break
        await new Promise((resolve) => setTimeout(resolve, RATE_WAIT_INTERVAL_MS))
        s = await call<VoiceCordStatus>(CH.getStatus)
      }
      if (injectRate === null) injectRate = fallbackRateForBuild(s.discordBuild)
    } catch {
      // 取れなくても既定値で進む
    }
    return injectRate ?? PREVIEW_SAMPLE_RATE
  }

  /** 音源 1 本を指定レートの mono / f32 にして返す。デコード失敗は理由つきで投げる */
  const pcmAt = async (soundPath: string, sampleRate: number): Promise<Float32Array> => {
    const bytes = await call<ArrayBuffer>(CH.readSoundFile, soundPath)
    return decodeToMono(bytes, soundPath, makeDecoder(sampleRate))
  }

  /** 試聴とラウドネス計測用。こちらは常に 48000 */
  const pcmOf = (soundPath: string): Promise<Float32Array> =>
    pcmAt(soundPath, PREVIEW_SAMPLE_RATE)

  const onEvent: VoiceCordApi['onEvent'] = (cb) => {
    const listener = (_e: unknown, ...args: unknown[]): void => {
      const payload = args[0]
      if (isVoiceCordEvent(payload)) cb(payload)
    }
    ipc.on(CH.event, listener)
    return () => ipc.removeListener(CH.event, listener)
  }

  // 注入レートは attach のたびに測り直される。状態を見張って追随する
  onEvent((e) => {
    if (e.ev === 'status') {
      injectRate = e.status.sampleRate ?? rateFromFrame(e.status.frameSamples)
      const pid = e.status.enginePid
      if (e.status.engine === 'attached' && pid !== null && pid !== masterEnginePid) {
        masterEnginePid = pid
        if (master !== null) void call<void>(CH.setMaster, master).catch(() => undefined)
      }
    }
  })

  return {
    getStatus: () => call<VoiceCordStatus>(CH.getStatus),
    subscribe: () => call<VoiceCordStatus>(CH.subscribe),
    onEvent,

    getConfig: () => call<LoadedConfig>(CH.getConfig),
    saveConfig: (partial: Partial<AppConfig>) => {
      for (const cb of configListeners) cb(partial)
      return call<void>(CH.saveConfig, partial)
    },
    onConfigSaved: (cb) => {
      configListeners.add(cb)
      return () => void configListeners.delete(cb)
    },

    // 自分がどのビルドに寄生しているかは自明なので、選ばせる意味が無い。
    // store.ts の呼び口を残したまま、現在のビルドだけを返す（M4.5 で UI ごと消える）
    listBuilds: async (): Promise<BuildKey[]> => {
      const s = await call<VoiceCordStatus>(CH.getStatus)
      return [s.discordBuild as BuildKey]
    },

    /**
     * 引数のビルドは無視する（自分がどこに寄生しているかは自明）。
     *
     * attach は自動なので、ここは原則「今の状態を読む」だけにする。
     * 無条件に再起動すると、Ctrl+R のたびにエンジンが死んで起き直すことになり、
     * M3 では frida の attach ごと落ちて数秒鳴らせなくなる。
     * 壊れているときだけ起こし直す。
     */
    attach: async (): Promise<AttachResult> => {
      let s = await call<VoiceCordStatus>(CH.getStatus)
      if (s.engine === 'failed') s = await call<VoiceCordStatus>(CH.reattach)
      // starting のまま返すと PID が null で「見つからず」に見える。落ち着くまで待つ
      for (let i = 0; i < ATTACH_SETTLE_TRIES && s.engine === 'starting'; i++) {
        await new Promise((r) => setTimeout(r, ATTACH_SETTLE_INTERVAL_MS))
        s = await call<VoiceCordStatus>(CH.getStatus)
      }
      return {
        ok: s.engine !== 'failed',
        pid: s.attachedPid,
        label: `${s.discordBuild} ${s.discordVersion}`
      }
    },
    detach: () => call<void>(CH.detach),

    scanFolder: (folder: string) => call<SoundItem[]>(CH.scanFolder, folder),
    chooseFolder: () => call<string | null>(CH.chooseFolder),

    // store.ts は ArrayBuffer を期待している（Float32Array のバッキングをそのまま渡す）
    getPcm: async (soundPath: string): Promise<ArrayBuffer> => {
      const pcm = await pcmOf(soundPath)
      return pcm.buffer as ArrayBuffer
    },

    play: async (req: PlayReq): Promise<string | null> => {
      // 鳴らす直前に PCM を engine へ渡す。engine は音源とレートをキーに持つので、
      // 同じ音源を同じレートで連打しても 2 回目以降は hook へ送り直さない。
      // **ここだけ注入レートでデコードする**（試聴の 48000 とは別）
      const sampleRate = await rateForInject()
      const pcm = await pcmAt(req.path, sampleRate)
      // キーは engine 側が srcId@fp@rate で作る。指紋だけだと別音源が同じ内容のとき衝突し、
      // レートを混ぜないと既定レートで送った PCM を計測後も使い回してピッチがずれる
      await call<void>(CH.preloadPcm, req.srcId, req.fp, sampleRate, pcm.buffer)
      const injectReq: InjectPlayReq = { ...req, sampleRate }
      return call<string | null>(CH.play, injectReq)
    },
    stop: (vid: string) => call<void>(CH.stop, vid),
    stopAll: () => call<void>(CH.stopAll),
    setVoiceVolume: (vid: string, vol: number) => call<void>(CH.setVoiceVolume, vid, vol),
    setMaster: (v: number) => {
      master = v
      return call<void>(CH.setMaster, v)
    },
    openGate: (guardMs: number) => call<void>(CH.openGate, guardMs),

    calibStart: (tag: string, frames: number) => call<void>(CH.calibStart, tag, frames),
    calibStop: () => call<void>(CH.calibStop),

    // 音源のラウドネス。声の計測と同じゲーティングで数える（shared/loudness）
    sourceStats: async (soundPath: string): Promise<SourceStats> => {
      const pcm = await pcmOf(soundPath)
      const m = measureSamples(pcm)
      // 「鳴っている時間の割合」は絶対ゲートを通ったブロック数で語る（loudness.ts の定義）
      const activeRatio = m.totalBlocks === 0 ? 0 : m.activeBlocks / m.totalBlocks
      return { rms: m.rms, peak: m.peak, samples: pcm.length, activeRatio }
    },

    // エンジン由来のイベントだけを store へ渡す。status / log は UI の器が受け取る
    onEngineEvent: (cb: (p: EngineEvent) => void) =>
      onEvent((e) => {
        if (e.ev === 'engine') cb(e.payload)
      })
  }
}

/** main から来た値を素通しせず、形を確かめてから UI に渡す */
export function isVoiceCordEvent(v: unknown): v is VoiceCordEvent {
  if (typeof v !== 'object' || v === null) return false
  const ev = (v as { ev?: unknown }).ev
  return ev === 'status' || ev === 'log' || ev === 'engine'
}
