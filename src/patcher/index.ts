import { app, BrowserWindow, dialog, globalShortcut, ipcMain, session, utilityProcess } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  createConfigStore,
  defaultConfig,
  defaultSoundsFolder,
  type ConfigStore
} from '../shared/config.js'
import { ENGINE_EMERGENCY_STOP } from '../shared/engineMsg.js'
import { CH, type VoiceCordStatus } from '../shared/ipc.js'
import { EMERGENCY_STOP_ACCELERATOR, registerEmergencyStop } from './emergencyStop.js'
import { voiceCordPathsFromEnv } from '../shared/paths.js'
import { markPatcherRun, readState, writeState } from '../shared/stateStore.js'
import { createEngineHost, type EngineHost, type EngineProcessLike } from './engineHost.js'
import { registerIpc, Subscribers } from './ipc.js'
import { guessBranch, locateInstall } from './locate.js'
import { registerPreload } from './preloadReg.js'
import { createSoundboardCache, resolveReadableSoundPath } from './soundboardCache.js'
import { scanFolder, type SoundsFs } from './soundsFs.js'
import { runSubsystems, summarize, type Subsystem, type SubsystemLog } from './subsystems.js'

/**
 * Discord の main プロセスで動く VoiceCord の入口。shim から require される。
 *
 * ここは Discord 本体を絶対にブートしない。ブートは shim の末尾か、連鎖の
 * 後ろにいる Vencord が行う。ここでブートすると二重起動や順序の破綻を招く。
 *
 * どのサブシステムが落ちても Discord は通常どおり起動しなければならない。
 * 特に UI（preload 登録）とエンジンは独立させ、エンジンが死んでいても
 * FAB は出て理由が読める状態を保つ。
 *
 * frida はここには載せない。エンジンは utilityProcess の子として起こす。
 */

const log: SubsystemLog = {
  info: (msg) => console.log(msg),
  error: (msg, err) => console.error(msg, err)
}

/** soundsFs へ渡す node の fs。統計は ns 精度のものを別口で取る */
const soundsFs: SoundsFs = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  statSyncBig: (p) => {
    const st = fs.statSync(p, { bigint: true })
    return { mtimeNs: st.mtimeNs, size: st.size }
  },
  readdirSync: (p) => fs.readdirSync(p),
  realpathSync: (p) => fs.realpathSync(p)
}

function main(): void {
  const paths = voiceCordPathsFromEnv(process.env, path.join)
  const install = locateInstall(require.main?.path)

  const subscribers = new Subscribers()
  const status: VoiceCordStatus = {
    engine: 'starting',
    attachedPid: null,
    enginePid: null,
    sampleRate: null,
    frameSamples: null,
    discordBuild: install ? guessBranch(install.resourcesDir) : 'unknown',
    discordVersion: install?.version ?? 'unknown',
    lastError: null,
    degraded: []
  }
  const broadcastStatus = (): void => subscribers.broadcast({ ev: 'status', status })

  let config: ConfigStore | null = null
  let engine: EngineHost | null = null

  /** サブシステムが落ちていたら、その旨を UI へ返す（無言で undefined を返さない） */
  const needConfig = (): ConfigStore => {
    if (config === null) throw new Error('設定を読み込めていません')
    return config
  }
  const needEngine = (): EngineHost => {
    if (engine === null) throw new Error('エンジンが起動していません')
    return engine
  }

  const subsystems: Subsystem[] = [
    {
      // 「mod が最後に動いた日時」を刻む。一度も動いていない = パッチが外れている、
      // がマネージャ側から時系列で読める（可視化 4）
      name: 'state',
      run: () => {
        if (!install) throw new Error('patcher の位置から Discord インストールを特定できません')
        const next = markPatcherRun(
          readState(fs, paths.state),
          install.resourcesDir,
          install.version,
          new Date().toISOString()
        )
        writeState(fs, paths.state, next, path.dirname)
      }
    },
    {
      name: 'config',
      run: () => {
        const home = process.env['USERPROFILE'] ?? app.getPath('home')
        const dfltFolder = defaultSoundsFolder(home, path.join)
        config = createConfigStore(fs, paths, defaultConfig(dfltFolder), path.dirname)
        // 既定のフォルダだけは自動で作る。VC に参加中しか UI が出ない構成なので、
        // 初回に「フォルダを選んでください」と言う場所が無い。
        // ユーザーが自分で指定したフォルダは勝手に作らない（打ち間違いを隠さない）
        if (config.get().folder === dfltFolder && !fs.existsSync(dfltFolder)) {
          fs.mkdirSync(dfltFolder, { recursive: true })
        }
      }
    },
    {
      // frida はこの子の中だけ。ネイティブが落ちても Discord は生き残る
      name: 'engine',
      run: () => {
        if (!fs.existsSync(paths.engine)) {
          throw new Error(`エンジンが見つかりません: ${paths.engine}`)
        }
        const host = createEngineHost({
          fork: () =>
            utilityProcess.fork(paths.engine, [], {
              stdio: 'pipe',
              serviceName: 'VoiceCord engine'
            }) as unknown as EngineProcessLike,
          emit: (e) => subscribers.broadcast(e),
          onState: (state, attachedPid, error, rate) => {
            status.engine = state
            status.attachedPid = attachedPid
            // 注入レートは Discord 側の都合で変わる。決め打ちにせず実測値を運ぶ
            status.sampleRate = rate.sampleRate
            status.frameSamples = rate.frameSamples
            // 実機で「どのプロセスがエンジンか」を判別する唯一の手がかり。
            // Discord 自身も node.mojom.NodeService を持っていて、
            // コマンドラインでは我々の子と区別できない
            status.enginePid = host.pid()
            status.lastError = error
            broadcastStatus()
          },
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
          now: () => Date.now()
        })
        engine = host
        // utilityProcess は app が ready になるまで使えない
        if (app.isReady()) host.start()
        else void app.whenReady().then(() => host.start())
        // 終了は投げっぱなし（判断 H）。preventDefault はしない。
        // 子側は parentPort の close でゲートを戻す（ゲート復帰 4 層の 1 層目）
        app.on('before-quit', () => host.stop())
      }
    },
    {
      // ゲート復帰 4 層の 4 層目。Discord にフォーカスが無くても、UI が壊れていても効く
      name: 'hotkey',
      run: () => {
        const register = (): void => {
          const r = registerEmergencyStop(globalShortcut, () => {
            const eng = engine
            if (eng === null) return
            eng.request(ENGINE_EMERGENCY_STOP, []).then(
              () =>
                subscribers.broadcast({
                  ev: 'log',
                  level: 'warn',
                  message: `緊急停止しました（${EMERGENCY_STOP_ACCELERATOR}）。再生を止め、送信ゲートを閉じました`
                }),
              (e: unknown) =>
                subscribers.broadcast({
                  ev: 'log',
                  level: 'error',
                  message: `緊急停止をエンジンへ届けられませんでした: ${e instanceof Error ? e.message : String(e)}`
                })
            )
          })
          if (!r.ok) {
            // 効かない脱出口を効くと思わせない。パネルに理由を常時出す
            status.degraded = [...status.degraded, { name: 'hotkey', error: r.error }]
            broadcastStatus()
            return
          }
          app.on('will-quit', () => globalShortcut.unregister(EMERGENCY_STOP_ACCELERATOR))
        }
        // globalShortcut は app が ready になるまで使えない
        if (app.isReady()) register()
        else void app.whenReady().then(register)
      }
    },
    {
      name: 'ipc',
      run: () => {
        // ほかのサーバーのサウンドの置き場（%TEMP%\VoiceCord\soundboard）。フォルダは初回の取得で作る
        const soundboard = createSoundboardCache()
        registerIpc(ipcMain, {
          subscribers,
          getStatus: () => status,
          config: {
            get: () => needConfig().get(),
            save: (partial) => needConfig().save(partial),
            get loadWarning() {
              return config?.loadWarning ?? null
            }
          },
          sounds: {
            scan: (folder) => scanFolder(soundsFs, folder),
            read: (folder, requested) => {
              // 取得したサウンドボード音声はフォルダの外にあるので、設定 ON のときだけキャッシュを先に通す
              const target = resolveReadableSoundPath({
                soundboard,
                unlocked: needConfig().get().unlockSoundboard === true,
                soundsFs,
                folder,
                requested
              })
              const buf = fs.readFileSync(target)
              // Buffer の backing store をそのまま渡すと、隣接する別データまで
              // 見せてしまう。切り出してから渡す
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
            }
          },
          chooseFolder: async () => {
            // Discord の窓を親にする。親を付けないとダイアログが後ろへ回り込み、
            // 「押しても何も起きない」ように見える
            const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            const opts = { properties: ['openDirectory' as const] }
            const r = parent
              ? await dialog.showOpenDialog(parent, opts)
              : await dialog.showOpenDialog(opts)
            return r.canceled ? null : (r.filePaths[0] ?? null)
          },
          soundboard: {
            fetch: (id) => soundboard.fetchSoundboardSound(id)
          },
          engine: {
            request: (ch, args) => needEngine().request(ch, args),
            restart: () => needEngine().restart()
          }
        })
      }
    },
    {
      // BrowserWindow はラップしない。Discord 側が既に sandbox:false /
      // contextIsolation:true を設定しているため、ラップする理由が無い。
      // Vencord の BrowserWindow サブクラスとも DISCORD_PRELOAD とも干渉しない。
      name: 'preload',
      run: () => {
        if (!fs.existsSync(paths.preload)) {
          throw new Error(`preload が見つかりません: ${paths.preload}`)
        }
        const attach = (ses: Electron.Session): void => {
          const r = registerPreload(ses, paths.preload)
          if (!r.ok) log.error('[VoiceCord] preload の登録に失敗しました', r.error)
        }
        // 将来 partition が付いた場合の保険として、後から作られるセッションにも足す
        app.on('session-created', attach)
        if (app.isReady()) attach(session.defaultSession)
        else void app.whenReady().then(() => attach(session.defaultSession))
      }
    }
  ]

  const outcomes = runSubsystems(subsystems, log)
  const { failures } = summarize(outcomes)
  // 上書きしない。ready 済みで起動されたときは hotkey が既に失敗を積んでいる
  status.degraded = [...status.degraded, ...failures]
  // エンジンが起動できなかったときだけ engine を failed にする。
  // 他のサブシステムの失敗は degraded で伝える（エンジンは生きているのに
  // 赤く光ると、どこが壊れているのか読み取れなくなる）
  if (failures.some((f) => f.name === 'engine')) {
    status.engine = 'failed'
    status.lastError = failures.find((f) => f.name === 'engine')?.error ?? null
  }
  broadcastStatus()
}

// 入口そのものが throw しても Discord を巻き添えにしない。
// ここで throw すると shim の per-entry try/catch には拾われるが、
// 二重の防御にしておく。
try {
  main()
} catch (e) {
  console.error('[VoiceCord] 起動に失敗しました。Discord は通常どおり続行します', e)
}

export { CH }
