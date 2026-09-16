import { CH, type VoiceCordEvent, type VoiceCordStatus } from '../shared/ipc.js'
import { isSoundboardSoundId } from '../shared/soundboard.js'
import type { AppConfig, LoadedConfig, SoundItem } from '../shared/types.js'

/**
 * ipcMain 側の窓口。
 *
 * 自前 mod なので Electron の IPC がそのまま使える。Vencord プラグインの
 * PluginNative と違い、main → renderer のプッシュも webContents.send で素直に書ける。
 *
 * 購読者は単一ウィンドウではなく集合で持つ。preload が全フレームに入るため、
 * 複数の renderer から購読されうる。
 *
 * チャンネルは 2 系統に分かれる。設定とファイルは patcher が自分で処理し、
 * 再生・ゲート・校正は engine（utilityProcess の子）へ転送する。engine が
 * 死んでいても前者は動き続ける ＝ 音は鳴らないが設定は読めて理由も読める。
 */

/** electron の ipcMain のうち、ここで使うものだけ */
export interface IpcMainLike {
  handle: (
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown
  ) => void
  removeHandler: (channel: string) => void
}

export interface IpcInvokeEventLike {
  sender: WebContentsLike
}

export interface WebContentsLike {
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  once: (event: 'destroyed', listener: () => void) => void
}

export type Handler = (event: IpcInvokeEventLike, ...args: unknown[]) => unknown

/** 購読者の集合。破棄済みの webContents に送らないよう、送信時にも掃除する */
export class Subscribers {
  private readonly set = new Set<WebContentsLike>()

  add(wc: WebContentsLike): void {
    if (this.set.has(wc)) return
    this.set.add(wc)
    wc.once('destroyed', () => this.set.delete(wc))
  }

  get size(): number {
    return this.set.size
  }

  broadcast(payload: VoiceCordEvent): void {
    for (const wc of [...this.set]) {
      if (wc.isDestroyed()) {
        this.set.delete(wc)
        continue
      }
      try {
        wc.send(CH.event, payload)
      } catch {
        // 送れない相手は落とす。1 つの失敗で他への配信を止めない
        this.set.delete(wc)
      }
    }
  }
}

export interface ConfigPort {
  get: () => AppConfig
  save: (partial: Partial<AppConfig>) => { ok: boolean; error?: string }
  readonly loadWarning: string | null
}

export interface SoundsPort {
  scan: (folder: string) => SoundItem[]
  /** folder 配下に限定して生ファイルを読む。外や非音声は throw */
  read: (folder: string, requested: string) => ArrayBuffer
}

export interface SoundboardPort {
  /** CDN から取得（キャッシュにあればそれ）して実パスを返す。失敗は理由つきで throw */
  fetch: (id: string) => Promise<string>
}

export interface EnginePort {
  request: (ch: string, args: unknown[]) => Promise<unknown>
  restart: () => void
}

export interface IpcDeps {
  subscribers: Subscribers
  getStatus: () => VoiceCordStatus
  config: ConfigPort
  sounds: SoundsPort
  /** ネイティブのフォルダ選択。取り消しなら null */
  chooseFolder: () => Promise<string | null>
  soundboard: SoundboardPort
  engine: EnginePort
}

/**
 * engine へそのまま転送するチャンネル。
 * ここに無いものは patcher が自分で処理する。
 */
export const ENGINE_CHANNELS: readonly string[] = [
  CH.detach,
  CH.preloadPcm,
  CH.play,
  CH.stop,
  CH.stopAll,
  CH.setVoiceVolume,
  CH.setMaster,
  CH.openGate,
  CH.calibStart,
  CH.calibStop
]

/**
 * ハンドラを登録する。
 * ipcMain.handle は同じチャンネルの二重登録で throw するので、必ず先に外す
 * （開発中に patcher を読み直したときのため）。
 */
export function registerIpc(ipcMain: IpcMainLike, deps: IpcDeps): void {
  const on = (channel: string, handler: Handler): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  on(CH.subscribe, (event) => {
    deps.subscribers.add(event.sender)
    return deps.getStatus()
  })

  on(CH.getStatus, () => deps.getStatus())

  on(CH.getConfig, (): LoadedConfig => {
    // 読めなかった理由や旧設定からの移行は起動直後に一度だけ画面へ出す。
    // 黙って既定値で動くと、ユーザーは設定が消えたことにしか気付けず、
    // しかも最初の保存で元ファイルごと失う
    return { ...deps.config.get(), loadWarning: deps.config.loadWarning }
  })

  on(CH.saveConfig, (_e, partial) => {
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      throw new Error('設定の形が想定と違います')
    }
    const r = deps.config.save(partial as Partial<AppConfig>)
    // 保存できなかったことを黙らせない。値は反映されているが次の起動で消える
    if (!r.ok) throw new Error(`設定を保存できませんでした: ${r.error ?? '理由不明'}`)
  })

  on(CH.scanFolder, (_e, folder) => {
    const target = typeof folder === 'string' && folder !== '' ? folder : deps.config.get().folder
    return deps.sounds.scan(target)
  })

  on(CH.chooseFolder, () => deps.chooseFolder())

  on(CH.readSoundFile, (_e, requested) => {
    if (typeof requested !== 'string') throw new Error('パスが指定されていません')
    return deps.sounds.read(deps.config.get().folder, requested)
  })

  on(CH.fetchSoundboardSound, async (_e, id) => {
    // ID は URL とファイル名にそのまま入る。renderer の検証とは独立に、ここでも数字だけに閉じる
    if (!isSoundboardSoundId(id)) throw new Error('サウンド ID の形が想定と違います')
    // renderer 側でも OFF なら呼ばないが、外部への通信とファイルの書き込みなので main でも設定を確かめる
    if (deps.config.get().unlockSoundboard !== true) {
      throw new Error('ほかのサーバーのサウンドを鳴らす設定がオフです')
    }
    const soundPath = await deps.soundboard.fetch(id)
    // 同じ ID の音声は差し替わらないので、ID をそのまま指紋にする（engine の PCM キャッシュのキー）
    return { path: soundPath, fp: `sb-${id}` }
  })

  // 再アタッチだけは engine への転送ではなくプロセスの起こし直し。
  // frida が固まった・エンジンが死んだ、を手で復旧する唯一の口
  on(CH.reattach, () => {
    deps.engine.restart()
    return deps.getStatus()
  })

  for (const channel of ENGINE_CHANNELS) {
    on(channel, (_e, ...args) => deps.engine.request(channel, args))
  }
}

/** まだ実装されていないチャンネルの断り方（無言で undefined を返さない） */
export function makeNotImplemented(milestone: string): (channel: string) => never {
  return (channel: string): never => {
    throw new Error(`${channel} はまだ実装されていません（${milestone} で実装予定）`)
  }
}
