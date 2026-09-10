import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
// asar を触るので original-fs を使う。素の fs は .asar を通るパスを
// アーカイブとして横取りしてしまい、リネームも読み取りもできない。
import originalFs from 'original-fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { voiceCordPathsFromEnv } from '../../shared/paths.js'
import { tasklistCommand } from '../patch/running.js'
import { resolvePayloadDir } from '../payloadDir.js'
import { applyTo, listInstalls, unpatchFrom, type ServiceDeps, type ServiceFs } from '../service.js'

/**
 * VoiceCord マネージャ。常駐しない。
 *
 * 役割はパッチの適用・解除・状態表示だけ。ランタイムは Discord の中で動く。
 */

const MCH = {
  list: 'vcm:list',
  apply: 'vcm:apply',
  unpatch: 'vcm:unpatch',
  openFolder: 'vcm:openFolder',
  restoreDoc: 'vcm:restoreDoc'
} as const

function payloadDir(): string {
  return resolvePayloadDir(
    { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname },
    path.join
  )
}

function makeDeps(): ServiceDeps {
  return {
    fs: originalFs as unknown as ServiceFs,
    paths: voiceCordPathsFromEnv(process.env, path.join),
    payloadDir: payloadDir(),
    localAppData: process.env['LOCALAPPDATA'] ?? '',
    join: path.join,
    dirname: path.dirname,
    listProcesses: (imageName) => {
      const [cmd, ...args] = tasklistCommand(imageName)
      // シェルを介さない。引数にユーザー入力は入らないが、原則として通さない
      return execFileSync(cmd!, args, { encoding: 'utf8', windowsHide: true })
    },
    now: () => new Date().toISOString()
  }
}

function registerIpc(): void {
  ipcMain.handle(MCH.list, () => listInstalls(makeDeps()))

  ipcMain.handle(MCH.apply, (_e, resourcesDir: unknown, extraChain: unknown) => {
    if (typeof resourcesDir !== 'string') return { ok: false, message: '不正な引数です' }
    const extra = Array.isArray(extraChain) ? extraChain.filter((x) => typeof x === 'string') : []
    return applyTo(makeDeps(), resourcesDir, { extraChain: extra })
  })

  ipcMain.handle(MCH.unpatch, (_e, resourcesDir: unknown, mode: unknown) => {
    if (typeof resourcesDir !== 'string') return { ok: false, message: '不正な引数です' }
    if (mode !== 'full' && mode !== 'voicecordOnly') return { ok: false, message: '不正なモードです' }
    return unpatchFrom(makeDeps(), resourcesDir, mode)
  })

  ipcMain.handle(MCH.openFolder, (_e, dir: unknown) => {
    if (typeof dir !== 'string') return
    shell.openPath(dir)
  })

  ipcMain.handle(MCH.restoreDoc, async () => {
    const paths = voiceCordPathsFromEnv(process.env, path.join)
    await dialog.showMessageBox({
      type: 'info',
      title: '復旧手順',
      message: 'Discord が起動しなくなったとき',
      detail:
        '1. タスクマネージャで Discord を全部終了する\n' +
        '2. エクスプローラで %LOCALAPPDATA%\\Discord（Canary なら DiscordCanary）を開く\n' +
        '3. 一番新しい app-1.0.xxxx → resources を開く\n' +
        '4. _app.asar（先頭にアンダースコア）があることを確認する\n' +
        '5. app.asar を削除する（数百バイト〜数KBの小さいファイル）\n' +
        '6. _app.asar を app.asar にリネームする\n' +
        '7. Discord を起動する\n\n' +
        '※ 手順 6 を行うと Vencord など他の mod も同時に外れます。\n\n' +
        `この手順は ${paths.restoreNote} にも置いてあります。`
    })
  })
}

function createWindow(): void {
  const dir = __dirname
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    title: 'VoiceCord マネージャ',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(dir, 'managerPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.setMenuBarVisibility(false)
  void win.loadFile(path.join(dir, 'manager.html'))
}

// 多重起動すると同じ app.asar を同時に触りうる
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    registerIpc()
    createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}

export { MCH }
