import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyTo, listInstalls, unpatchFrom, type ServiceDeps } from '../src/manager/service.js'
import { buildFlatAsar } from '../src/manager/patch/asarBuild.js'
import { classifyAppAsar } from '../src/manager/patch/asarInspect.js'
import { SHIM_PACKAGE_JSON } from '../src/manager/patch/shimSource.js'
import { voiceCordPaths } from '../src/shared/paths.js'
import { getInstall, readState } from '../src/shared/stateStore.js'

const RUNNING = '"DiscordCanary.exe","1234","Console","2","70,624 K"'
const NOT_RUNNING = 'INFO: No tasks are running which match the specified criteria.'

let root: string
let deps: ServiceDeps
let canaryResources: string

const plain = (): Buffer =>
  buildFlatAsar({ 'bundle.js': 'x'.repeat(300), 'package.json': '{"main":"bundle.js"}' })
const foreign = (p: string): Buffer =>
  buildFlatAsar({ 'index.js': `require(${JSON.stringify(p)})`, 'package.json': SHIM_PACKAGE_JSON })

function makeDeps(
  lister: (image: string) => string = () => NOT_RUNNING,
  overrides: Partial<ServiceDeps> = {}
): ServiceDeps {
  const localAppData = path.join(root, 'Local')
  const paths = voiceCordPaths({ localAppData, appData: path.join(root, 'Roaming') }, path.join)
  return {
    fs,
    paths,
    payloadDir: path.join(root, 'payload'),
    localAppData,
    join: path.join,
    dirname: path.dirname,
    listProcesses: lister,
    killProcess: () => {
      throw new Error('強制終了は呼ばれない想定です')
    },
    sleep: () => {},
    startDiscord: () => {
      throw new Error('再起動は呼ばれない想定です')
    },
    now: () => '2026-09-07T12:00:00.000Z',
    ...overrides
  }
}

/**
 * 強制終了の流れを偽装する。kill されてから `pollsUntilExit` 回目の確認で終了したことにする。
 * Infinity なら終了しない。
 */
function makeForceDeps(pollsUntilExit = 0) {
  const calls = { killed: [] as string[], started: [] as Array<[string, string]>, slept: 0 }
  let killed = false
  let pollsAfterKill = 0
  const lister = (image: string): string => {
    if (image !== 'DiscordCanary.exe') return NOT_RUNNING
    if (!killed) return RUNNING
    if (pollsAfterKill++ < pollsUntilExit) return RUNNING
    return NOT_RUNNING
  }
  const d = makeDeps(lister, {
    killProcess: (image) => {
      calls.killed.push(image)
      killed = true
    },
    sleep: () => {
      calls.slept++
    },
    startDiscord: (rootDir, exeName) => {
      calls.started.push([rootDir, exeName])
    }
  })
  return { d, calls }
}

const canaryRoot = (): string => path.join(root, 'Local', 'DiscordCanary')
const putUpdateExe = (): void => fs.writeFileSync(path.join(canaryRoot(), 'Update.exe'), '')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-svc-'))
  canaryResources = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1099', 'resources')
  fs.mkdirSync(canaryResources, { recursive: true })
  fs.writeFileSync(path.join(canaryResources, 'app.asar'), plain())
  // ビルド成果物のダミー
  fs.mkdirSync(path.join(root, 'payload', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'payload', 'patcher.js'), '// patcher')
  fs.writeFileSync(path.join(root, 'payload', 'preload.js'), '// preload')
  fs.writeFileSync(path.join(root, 'payload', 'sub', 'nested.txt'), 'nested')
  deps = makeDeps()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('listInstalls', () => {
  it('未パッチの Canary を clean として出す', () => {
    const rows = listInstalls(deps)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ branch: 'canary', version: '1.0.1099', state: 'clean', active: false })
  })

  it('起動中かどうかを出す', () => {
    const rows = listInstalls(makeDeps((image) => (image === 'DiscordCanary.exe' ? RUNNING : NOT_RUNNING)))
    expect(rows[0]!.running).toBe(true)
  })

  it('他 mod 入りを otherMod として出し、require 先を detail に載せる', () => {
    fs.writeFileSync(path.join(canaryResources, '_app.asar'), plain())
    fs.writeFileSync(path.join(canaryResources, 'app.asar'), foreign('C:/Vencord/patcher.js'))
    const rows = listInstalls(deps)
    expect(rows[0]!.state).toBe('otherMod')
    expect(rows[0]!.detail).toContain('Vencord')
  })
})

describe('applyTo', () => {
  it('ペイロードを配ってからパッチを当てる', () => {
    const r = applyTo(deps, canaryResources)
    expect(r.ok).toBe(true)

    // shim が指す先が先に用意されていること。逆順だと patcher の無い状態で
    // Discord が起動してしまう
    expect(fs.existsSync(deps.paths.patcher)).toBe(true)
    expect(fs.existsSync(deps.paths.preload)).toBe(true)
    // 入れ子のディレクトリも配る
    expect(fs.existsSync(path.join(deps.paths.dist, 'sub', 'nested.txt'))).toBe(true)

    const after = classifyAppAsar(fs, path.join(canaryResources, 'app.asar'))
    expect(after.kind).toBe('shim')
    if (after.kind === 'shim') expect(after.chain).toEqual([deps.paths.patcher])
  })

  it('state.json に記録を残す', () => {
    applyTo(deps, canaryResources)
    const rec = getInstall(readState(fs, deps.paths.state), canaryResources)
    expect(rec).toMatchObject({
      branch: 'canary',
      discordVersion: '1.0.1099',
      patchedAt: '2026-09-07T12:00:00.000Z'
    })
    expect(rec!.originalSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('適用に成功したら AV の除外先を案内する（frida を隔離されると無言で鳴らなくなる）', () => {
    const r = applyTo(deps, canaryResources)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Defender')
    expect(r.message).toContain(deps.paths.root)
  })

  it('適用後は active になる', () => {
    applyTo(deps, canaryResources)
    expect(listInstalls(deps)[0]).toMatchObject({ state: 'voicecord', active: true })
  })

  it('Discord が起動中なら断る（既定では強制終了しない）', () => {
    // killProcess / startDiscord は呼ばれると例外を投げる既定の偽装のまま
    const d = makeDeps((image) => (image === 'DiscordCanary.exe' ? RUNNING : NOT_RUNNING))
    const r = applyTo(d, canaryResources)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('起動しています')
    // 一切触っていないこと
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(fs.existsSync(d.paths.dist)).toBe(false)
  })

  it('forceClose なら exe 名で強制終了し、終了を待ってから適用して再起動する', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(2)
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(true)
    expect(calls.killed).toEqual(['DiscordCanary.exe'])
    // 2 回は起動中のままだったので、その間は待っている
    expect(calls.slept).toBe(2)
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('shim')
    expect(calls.started).toEqual([[canaryRoot(), 'DiscordCanary.exe']])
    expect(r.message).toContain('Discord Canary の再起動を開始しました')
  })

  it('forceClose でも終了しなければ適用せず、再起動もしない', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(Infinity)
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Discord Canary を終了できませんでした')
    expect(calls.killed).toEqual(['DiscordCanary.exe'])
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(fs.existsSync(d.paths.dist)).toBe(false)
    expect(calls.started).toEqual([])
  })

  it('forceClose でも、起動状態を判定できなければ強制終了せずに断る', () => {
    putUpdateExe()
    const calls = { killed: 0, started: 0 }
    const d = makeDeps(
      () => {
        throw new Error('tasklist が無い')
      },
      {
        killProcess: () => {
          calls.killed++
        },
        startDiscord: () => {
          calls.started++
        }
      }
    )
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('起動状態を確認できません')
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(calls).toEqual({ killed: 0, started: 0 })
  })

  it('forceClose で終了しなければ、タスクマネージャーでの終了を案内する', () => {
    const { d } = makeForceDeps(Infinity)
    expect(applyTo(d, canaryResources, { forceClose: true }).message).toContain('タスクマネージャーで DiscordCanary.exe を終了')
  })

  it('強制終了した後は、本処理が例外を投げても再起動する', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(0)
    const failingFs = Object.create(d.fs) as ServiceDeps['fs']
    failingFs.renameSync = (from, to) => {
      if (String(to) === d.paths.state) throw new Error('状態を書けません')
      return fs.renameSync(from, to)
    }
    const r = applyTo({ ...d, fs: failingFs }, canaryResources, { forceClose: true })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('状態を書けません')
    expect(calls.started).toHaveLength(1)
  })

  it('再起動に失敗したら手動での起動を案内し、本処理の結果は保つ', () => {
    putUpdateExe()
    const { d } = makeForceDeps(0)
    d.startDiscord = () => {
      throw new Error('起動できません')
    }
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Discord Canary を手動で起動してください')
  })

  it('taskkill が失敗しても、実際に終了していれば続行する', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(0)
    const kill = d.killProcess
    d.killProcess = (image) => {
      kill(image)
      throw new Error('プロセスが見つかりません')
    }
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(true)
    expect(calls.started).toHaveLength(1)
  })

  it('起動していなければ forceClose でも終了も再起動もしない', () => {
    putUpdateExe()
    // 既定の偽装は killProcess / startDiscord が呼ばれると例外を投げる
    const r = applyTo(deps, canaryResources, { forceClose: true })
    expect(r.ok).toBe(true)
    expect(r.message).not.toContain('再起動')
  })

  it('Update.exe が無ければ再起動せず、手動で起動するよう案内する', () => {
    const { d, calls } = makeForceDeps(0)
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(true)
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('shim')
    expect(calls.started).toEqual([])
    expect(r.message).toContain('手動で起動してください')
  })

  it('強制終了した後は、適用に失敗しても再起動する', () => {
    putUpdateExe()
    fs.rmSync(path.join(root, 'payload'), { recursive: true, force: true })
    const { d, calls } = makeForceDeps(0)
    const r = applyTo(d, canaryResources, { forceClose: true })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('ビルド成果物がありません')
    expect(calls.started).toHaveLength(1)
    expect(r.message).toContain('Discord Canary の再起動を開始しました')
  })

  it('他 mod を引き継いだことを伝える', () => {
    fs.writeFileSync(path.join(canaryResources, '_app.asar'), plain())
    fs.writeFileSync(path.join(canaryResources, 'app.asar'), foreign('C:/Vencord/patcher.js'))
    const r = applyTo(deps, canaryResources)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('引き継ぎ')
  })

  it('配置済みペイロードが同一なら再コピーしない', () => {
    expect(applyTo(deps, canaryResources).ok).toBe(true)
    const noCopyFs = Object.create(deps.fs) as ServiceDeps['fs']
    noCopyFs.copyFileSync = () => {
      throw new Error('同一ファイルをコピーしようとしました')
    }

    expect(applyTo({ ...deps, fs: noCopyFs }, canaryResources).ok).toBe(true)
  })

  it('extraChain を足せる（Canary での連鎖テスト）', () => {
    const r = applyTo(deps, canaryResources, { extraChain: ['C:/Vencord/patcher.js'] })
    expect(r.ok).toBe(true)
    const after = classifyAppAsar(fs, path.join(canaryResources, 'app.asar'))
    if (after.kind === 'shim') {
      expect(after.chain[0]).toBe(deps.paths.patcher)
      expect(after.chain[1]).toBe('C:/Vencord/patcher.js')
    }
  })

  it('ビルド成果物が無ければ、パッチを当てずに断る', () => {
    fs.rmSync(path.join(root, 'payload'), { recursive: true, force: true })
    const r = applyTo(deps, canaryResources)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('ビルド成果物がありません')
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
  })

  it('壊れた app.asar には触らない', () => {
    fs.writeFileSync(path.join(canaryResources, 'app.asar'), Buffer.alloc(40, 0xee))
    const r = applyTo(deps, canaryResources)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('想定外')
  })

  it('知らないインストールは断る', () => {
    expect(applyTo(deps, path.join(root, 'nope')).ok).toBe(false)
  })
})

describe('unpatchFrom', () => {
  beforeEach(() => {
    applyTo(deps, canaryResources)
  })

  it('full で素に戻し、記録も消す', () => {
    const r = unpatchFrom(deps, canaryResources, 'full')
    expect(r.ok).toBe(true)
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(fs.existsSync(path.join(canaryResources, '_app.asar'))).toBe(false)
    expect(getInstall(readState(fs, deps.paths.state), canaryResources)).toBeUndefined()
  })

  it('起動中なら断る', () => {
    const d = makeDeps((image) => (image === 'DiscordCanary.exe' ? RUNNING : NOT_RUNNING))
    const r = unpatchFrom(d, canaryResources, 'full')
    expect(r.ok).toBe(false)
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('shim')
  })

  it('forceClose なら強制終了してから外し、再起動する', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(1)
    const r = unpatchFrom(d, canaryResources, 'full', { forceClose: true })
    expect(r.ok).toBe(true)
    expect(calls.killed).toEqual(['DiscordCanary.exe'])
    expect(calls.slept).toBe(1)
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(calls.started).toEqual([[canaryRoot(), 'DiscordCanary.exe']])
    expect(r.message).toContain('Discord Canary の再起動を開始しました')
  })

  it('forceClose でも終了しなければ外さない', () => {
    const { d, calls } = makeForceDeps(Infinity)
    const r = unpatchFrom(d, canaryResources, 'full', { forceClose: true })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('終了できませんでした')
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('shim')
    expect(calls.started).toEqual([])
  })

  it('voicecordOnly も forceClose で強制終了してから外し、再起動する', () => {
    putUpdateExe()
    const { d, calls } = makeForceDeps(0)
    const r = unpatchFrom(d, canaryResources, 'voicecordOnly', { forceClose: true })
    expect(r.ok).toBe(true)
    expect(calls.killed).toEqual(['DiscordCanary.exe'])
    expect(calls.started).toHaveLength(1)
  })

  it('起動していなければ forceClose でも終了も再起動もしない', () => {
    putUpdateExe()
    const r = unpatchFrom(deps, canaryResources, 'full', { forceClose: true })
    expect(r.ok).toBe(true)
    expect(r.message).not.toContain('再起動')
  })

  it('voicecordOnly は他 mod を残す', () => {
    unpatchFrom(deps, canaryResources, 'full')
    applyTo(deps, canaryResources, { extraChain: ['C:/Vencord/patcher.js'] })
    const r = unpatchFrom(deps, canaryResources, 'voicecordOnly')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('他 mod は残しています')
    const after = classifyAppAsar(fs, path.join(canaryResources, 'app.asar'))
    if (after.kind === 'shim') expect(after.chain).toEqual(['C:/Vencord/patcher.js'])
  })

  it('更新先から VoiceCord だけ外すと他 mod のみになり、古い版の警告も消える', () => {
    unpatchFrom(deps, canaryResources, 'full')
    applyTo(deps, canaryResources, { extraChain: ['C:/Vencord/patcher.js'] })

    const newer = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1100', 'resources')
    fs.mkdirSync(newer, { recursive: true })
    fs.copyFileSync(path.join(canaryResources, 'app.asar'), path.join(newer, 'app.asar'))
    fs.copyFileSync(path.join(canaryResources, '_app.asar'), path.join(newer, '_app.asar'))

    expect(unpatchFrom(deps, newer, 'voicecordOnly').ok).toBe(true)
    expect(listInstalls(deps)[0]).toMatchObject({
      state: 'otherMod',
      active: false,
      staleVersion: false,
      patchedVersion: null
    })
  })
})

describe('再適用の必要性（可視化 3）', () => {
  it('Discord が更新されたら staleVersion が立つ', () => {
    applyTo(deps, canaryResources)
    expect(listInstalls(deps)[0]!.staleVersion).toBe(false)

    // Discord が更新されて新しい app-* が現れた状況
    const newer = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1100', 'resources')
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(path.join(newer, 'app.asar'), plain())

    const rows = listInstalls(deps)
    // 走査は最新だけを見る。新しい方は未パッチなので clean
    expect(rows[0]!.version).toBe('1.0.1100')
    expect(rows[0]!.state).toBe('clean')
    expect(rows[0]!.active).toBe(false)
  })

  it('更新先にも VoiceCord が有効なら古い記録だけで stale にしない', () => {
    applyTo(deps, canaryResources)
    const newer = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1100', 'resources')
    fs.mkdirSync(newer, { recursive: true })
    fs.copyFileSync(path.join(canaryResources, 'app.asar'), path.join(newer, 'app.asar'))
    fs.copyFileSync(path.join(canaryResources, '_app.asar'), path.join(newer, '_app.asar'))

    expect(listInstalls(deps)[0]).toMatchObject({ active: true, staleVersion: false, patchedVersion: null })
  })
})

describe('Discord の更新でパッチが外れたときの警告（実機で踏んだ回帰）', () => {
  it('更新後の新しい app-* でも「再適用が必要」と分かる', () => {
    // Canary 1.0.1099 に適用したあと、Discord が 1.0.1158 へ自動更新し、
    // 旧 app-1.0.1099 が丸ごと消える、という実機で起きた状況を再現する。
    applyTo(deps, canaryResources)
    expect(listInstalls(deps)[0]).toMatchObject({ active: true, staleVersion: false })

    const newer = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1158', 'resources')
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(path.join(newer, 'app.asar'), plain())
    // 旧バージョンは Discord の更新で消える
    fs.rmSync(path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1099'), { recursive: true, force: true })

    const row = listInstalls(deps)[0]!
    expect(row.version).toBe('1.0.1158')
    expect(row.state).toBe('clean')
    expect(row.active).toBe(false)
    // resourcesDir で記録を引くとここが false になり、無言で鳴らなくなる
    expect(row.staleVersion).toBe(true)
    expect(row.patchedVersion).toBe('1.0.1099')
  })

  it('再適用すれば警告は消える', () => {
    applyTo(deps, canaryResources)
    const newer = path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1158', 'resources')
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(path.join(newer, 'app.asar'), plain())
    fs.rmSync(path.join(root, 'Local', 'DiscordCanary', 'app-1.0.1099'), { recursive: true, force: true })

    expect(applyTo(deps, newer).ok).toBe(true)
    const row = listInstalls(deps)[0]!
    expect(row).toMatchObject({ version: '1.0.1158', active: true, staleVersion: false })
  })

  it('一度も適用していないブランチには警告を出さない', () => {
    const ptb = path.join(root, 'Local', 'DiscordPTB', 'app-1.0.1210', 'resources')
    fs.mkdirSync(ptb, { recursive: true })
    fs.writeFileSync(path.join(ptb, 'app.asar'), plain())
    applyTo(deps, canaryResources)

    const ptbRow = listInstalls(deps).find((r) => r.branch === 'ptb')!
    expect(ptbRow.staleVersion).toBe(false)
    expect(ptbRow.patchedVersion).toBeNull()
  })
})
