import { app, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { CH, type VoiceCordStatus } from '../shared/ipc.js'
import { voiceCordPathsFromEnv } from '../shared/paths.js'
import { markPatcherRun, readState, writeState } from '../shared/stateStore.js'
import { makeNotImplemented, registerIpc, Subscribers } from './ipc.js'
import { guessBranch, locateInstall } from './locate.js'
import { registerPreload } from './preloadReg.js'
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
 */

const log: SubsystemLog = {
  info: (msg) => console.log(msg),
  error: (msg, err) => console.error(msg, err)
}

function main(): void {
  const paths = voiceCordPathsFromEnv(process.env, path.join)
  const install = locateInstall(require.main?.path)

  const subscribers = new Subscribers()
  const status: VoiceCordStatus = {
    // M1 ではエンジンがまだ無い。存在しないものを attached とは言わない
    engine: 'starting',
    attachedPid: null,
    discordBuild: install ? guessBranch(install.resourcesDir) : 'unknown',
    discordVersion: install?.version ?? 'unknown',
    lastError: null,
    degraded: []
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
      name: 'ipc',
      run: () => {
        registerIpc(ipcMain, {
          subscribers,
          getStatus: () => status,
          notImplemented: makeNotImplemented('M2')
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
  status.degraded = failures
  if (failures.length > 0) {
    status.engine = 'failed'
    status.lastError = failures.map((f) => `${f.name}: ${f.error}`).join(' / ')
  }
  subscribers.broadcast({ ev: 'status', status })
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
