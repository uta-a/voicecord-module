import { contextBridge, ipcRenderer } from 'electron'

/**
 * マネージャ側の preload。
 *
 * ここは Discord の中ではなく自前のウィンドウなので、素直に contextBridge で
 * 必要な操作だけを露出する。パッチという破壊的な操作を扱うため、露出するのは
 * 決め打ちの 5 つだけにして、任意チャンネルを叩けるようにはしない。
 */

const MCH = {
  list: 'vcm:list',
  apply: 'vcm:apply',
  unpatch: 'vcm:unpatch',
  openFolder: 'vcm:openFolder',
  restoreDoc: 'vcm:restoreDoc'
} as const

contextBridge.exposeInMainWorld('vcm', {
  list: () => ipcRenderer.invoke(MCH.list),
  apply: (resourcesDir: string, extraChain: string[]) =>
    ipcRenderer.invoke(MCH.apply, resourcesDir, extraChain),
  unpatch: (resourcesDir: string, mode: 'full' | 'voicecordOnly') =>
    ipcRenderer.invoke(MCH.unpatch, resourcesDir, mode),
  openFolder: (dir: string) => ipcRenderer.invoke(MCH.openFolder, dir),
  restoreDoc: () => ipcRenderer.invoke(MCH.restoreDoc)
})
