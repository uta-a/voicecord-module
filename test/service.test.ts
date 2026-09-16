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

function makeDeps(lister: (image: string) => string = () => NOT_RUNNING): ServiceDeps {
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
    now: () => '2026-09-07T12:00:00.000Z'
  }
}

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

  it('Discord が起動中なら断る（強制終了はしない）', () => {
    const d = makeDeps((image) => (image === 'DiscordCanary.exe' ? RUNNING : NOT_RUNNING))
    const r = applyTo(d, canaryResources)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('起動しています')
    // 一切触っていないこと
    expect(classifyAppAsar(fs, path.join(canaryResources, 'app.asar')).kind).toBe('plain')
    expect(fs.existsSync(d.paths.dist)).toBe(false)
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
