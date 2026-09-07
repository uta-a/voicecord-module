import { CH, type EngineEvent, type VoiceCordStatus } from '../shared/ipc.js'

/**
 * ipcMain 側の骨格。
 *
 * 自前 mod なので Electron の IPC がそのまま使える。Vencord プラグインの
 * PluginNative と違い、main → renderer のプッシュも webContents.send で素直に書ける。
 *
 * 購読者は単一ウィンドウではなく集合で持つ。preload が全フレームに入るため、
 * ポップアウトなど複数の renderer から購読されうる。
 */

/** electron の ipcMain のうち、ここで使うものだけ */
export interface IpcMainLike {
  handle: (channel: string, listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown) => void
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

/**
 * 購読者の集合。破棄済みの webContents に送らないよう、送信時にも掃除する。
 */
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

  broadcast(payload: EngineEvent): void {
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

export interface IpcDeps {
  subscribers: Subscribers
  getStatus: () => VoiceCordStatus
  /** M1 ではエンジンが無いので、未実装のチャンネルはここに集約して明示的に断る */
  notImplemented: (channel: string) => never
}

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

  // M1 ではエンジンもフォルダ走査も無い。無言で undefined を返さず、
  // 呼ばれたことが分かる形で断る（このリポジトリの「無言で失敗させない」方針）。
  for (const channel of [
    CH.getConfig,
    CH.saveConfig,
    CH.reattach,
    CH.detach,
    CH.scanFolder,
    CH.chooseFolder,
    CH.readSoundFile,
    CH.preloadPcm,
    CH.play,
    CH.stop,
    CH.stopAll,
    CH.setVoiceVolume,
    CH.setMaster,
    CH.openGate,
    CH.calibStart,
    CH.calibStop
  ]) {
    on(channel, () => deps.notImplemented(channel))
  }
}

/** 未実装チャンネルの既定の断り方 */
export function makeNotImplemented(milestone: string): (channel: string) => never {
  return (channel: string): never => {
    throw new Error(`${channel} はまだ実装されていません（${milestone} で実装予定）`)
  }
}
