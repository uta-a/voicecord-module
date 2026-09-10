import { CH, type VoiceCordEvent, type VoiceCordStatus } from '../shared/ipc.js'

/**
 * renderer 側の窓口。
 *
 * isolated world の window は Discord のページとは別物なので、`window.api = api`
 * と書くだけで済む。contextBridge すら要らず、しかも Discord のスクリプトや
 * 他の mod からは触れない。contextBridge で露出するより厳密に閉じている。
 */

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

export interface VoiceCordApi {
  getStatus(): Promise<VoiceCordStatus>
  /** 購読を始めて、その時点の状態を受け取る */
  subscribe(): Promise<VoiceCordStatus>
  /** 戻り値を呼ぶと購読を解除する */
  onEvent(cb: (e: VoiceCordEvent) => void): () => void
}

export function createApi(ipc: IpcRendererLike): VoiceCordApi {
  return {
    getStatus: () => ipc.invoke(CH.getStatus) as Promise<VoiceCordStatus>,
    subscribe: () => ipc.invoke(CH.subscribe) as Promise<VoiceCordStatus>,
    onEvent: (cb) => {
      const listener = (_e: unknown, ...args: unknown[]): void => {
        const payload = args[0]
        if (isVoiceCordEvent(payload)) cb(payload)
      }
      ipc.on(CH.event, listener)
      return () => ipc.removeListener(CH.event, listener)
    }
  }
}

/** main から来た値を素通しせず、形を確かめてから UI に渡す */
export function isVoiceCordEvent(v: unknown): v is VoiceCordEvent {
  if (typeof v !== 'object' || v === null) return false
  const ev = (v as { ev?: unknown }).ev
  return ev === 'status' || ev === 'log' || ev === 'engine'
}
