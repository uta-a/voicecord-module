import { CH, type VoiceCordEvent, type VoiceCordStatus } from '../shared/ipc.js'
import { measureSamples } from '../shared/loudness.js'
import type {
  Api,
  AppConfig,
  AttachResult,
  BuildKey,
  EngineEvent,
  LoadedConfig,
  PlayReq,
  SoundItem,
  SourceStats
} from '../shared/types.js'
import { createOfflineDecoder, decodeToMono, type AudioDecoder } from './decode.js'

/**
 * renderer 側の窓口。
 *
 * isolated world の window は Discord のページとは別物なので、`window.api = api`
 * と書くだけで済む。contextBridge すら要らず、しかも Discord のスクリプトや
 * 他の mod からは触れない。contextBridge で露出するより厳密に閉じている。
 *
 * デコードはここで行う。main へ生ファイルを要求し、renderer の
 * `decodeAudioData` で 48kHz / mono / f32 にする。ffmpeg を持ち込まずに済み、
 * store.ts の `getPcm` の呼び口は無改造のまま使える。
 */

/** attach の結果が落ち着くまで待つ回数と間隔（合計 3 秒） */
export const ATTACH_SETTLE_TRIES = 20
export const ATTACH_SETTLE_INTERVAL_MS = 150

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
}

export function createApi(ipc: IpcRendererLike, decode: AudioDecoder = createOfflineDecoder()): VoiceCordApi {
  const call = <T>(ch: string, ...args: unknown[]): Promise<T> => ipc.invoke(ch, ...args) as Promise<T>

  /** 音源 1 本を 48k / mono / f32 にして返す。デコード失敗は理由つきで投げる */
  const pcmOf = async (soundPath: string): Promise<Float32Array> => {
    const bytes = await call<ArrayBuffer>(CH.readSoundFile, soundPath)
    return decodeToMono(bytes, soundPath, decode)
  }

  const onEvent: VoiceCordApi['onEvent'] = (cb) => {
    const listener = (_e: unknown, ...args: unknown[]): void => {
      const payload = args[0]
      if (isVoiceCordEvent(payload)) cb(payload)
    }
    ipc.on(CH.event, listener)
    return () => ipc.removeListener(CH.event, listener)
  }

  return {
    getStatus: () => call<VoiceCordStatus>(CH.getStatus),
    subscribe: () => call<VoiceCordStatus>(CH.subscribe),
    onEvent,

    getConfig: () => call<LoadedConfig>(CH.getConfig),
    saveConfig: (partial: Partial<AppConfig>) => call<void>(CH.saveConfig, partial),

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
      // 鳴らす直前に PCM を engine へ渡す。engine は fp をキーに持つので、
      // 同じ音源を連打しても 2 回目以降は運ばない
      const pcm = await pcmOf(req.path)
      await call<void>(CH.preloadPcm, req.fp, pcm.buffer)
      return call<string | null>(CH.play, req)
    },
    stop: (vid: string) => call<void>(CH.stop, vid),
    stopAll: () => call<void>(CH.stopAll),
    setVoiceVolume: (vid: string, vol: number) => call<void>(CH.setVoiceVolume, vid, vol),
    setMaster: (v: number) => call<void>(CH.setMaster, v),
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
