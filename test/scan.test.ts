import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFlatAsar } from '../src/manager/patch/asarBuild.js'
import { renderShimSource, SHIM_PACKAGE_JSON } from '../src/manager/patch/shimSource.js'
import {
  compareVersions,
  installState,
  isVoiceCordActive,
  newestAppDir,
  parseAppDirName,
  scanInstalls
} from '../src/manager/patch/scan.js'

const BS = String.fromCharCode(92)
const win = (s: string): string => s.split('/').join(BS)
const VOICECORD = win('C:/VoiceCord/dist/patcher.js')
const VENCORD = win('C:/Vencord/dist/patcher.js')

describe('compareVersions', () => {
  it('数値として比較する（辞書順ではない）', () => {
    // ここが辞書順だと 1.0.999 のほうが新しいと誤判定し、
    // 古いインストールにパッチを当ててしまう
    expect(compareVersions('1.0.1099', '1.0.999')).toBeGreaterThan(0)
    expect(compareVersions('1.0.9256', '1.0.10000')).toBeLessThan(0)
  })

  it('同じなら 0、桁数違いも扱える', () => {
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.2', '1.0')).toBeGreaterThan(0)
  })
})

describe('parseAppDirName', () => {
  it('app- 接頭辞つきだけを受け付ける', () => {
    expect(parseAppDirName('app-1.0.9256')).toBe('1.0.9256')
    expect(parseAppDirName('packages')).toBeNull()
    expect(parseAppDirName('app-')).toBeNull()
    expect(parseAppDirName('Update.exe')).toBeNull()
  })
})

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-scan-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeInstall(
  dirName: string,
  version: string,
  files: Record<string, Buffer>
): string {
  const res = path.join(root, dirName, `app-${version}`, 'resources')
  fs.mkdirSync(res, { recursive: true })
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(res, name), buf)
  return res
}

const plain = (): Buffer =>
  buildFlatAsar({ 'bundle.js': 'x'.repeat(300), 'package.json': '{"main":"bundle.js"}' })
const vcShim = (chain: string[]): Buffer =>
  buildFlatAsar({ 'index.js': renderShimSource(chain), 'package.json': SHIM_PACKAGE_JSON })
const foreign = (p: string): Buffer =>
  buildFlatAsar({ 'index.js': `require(${JSON.stringify(p)})`, 'package.json': SHIM_PACKAGE_JSON })

describe('newestAppDir', () => {
  it('数値として最新のものを選ぶ', () => {
    for (const v of ['1.0.999', '1.0.1099', '1.0.1078']) {
      fs.mkdirSync(path.join(root, 'DiscordCanary', `app-${v}`, 'resources'), { recursive: true })
    }
    fs.mkdirSync(path.join(root, 'DiscordCanary', 'packages'), { recursive: true })
    const got = newestAppDir(fs, path.join(root, 'DiscordCanary'))
    expect(got?.version).toBe('1.0.1099')
  })

  it('インストールされていなければ null', () => {
    expect(newestAppDir(fs, path.join(root, 'Nope'))).toBeNull()
  })
})

describe('scanInstalls', () => {
  it('入っているブランチだけを返す', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': plain() })
    makeInstall('DiscordCanary', '1.0.1099', { 'app.asar': plain() })
    const got = scanInstalls(fs, { localAppData: root, join: path.join })
    expect(got.map((i) => i.spec.branch)).toEqual(['stable', 'canary'])
  })

  it('resources が無いインストールは飛ばす', () => {
    fs.mkdirSync(path.join(root, 'Discord', 'app-1.0.1'), { recursive: true })
    expect(scanInstalls(fs, { localAppData: root, join: path.join })).toEqual([])
  })
})

describe('installState', () => {
  const scan = (): ReturnType<typeof scanInstalls> =>
    scanInstalls(fs, { localAppData: root, join: path.join })

  it('未パッチは clean', () => {
    makeInstall('DiscordCanary', '1.0.1099', { 'app.asar': plain() })
    expect(installState(scan()[0]!)).toEqual({ state: 'clean' })
  })

  it('VoiceCord 入りは voicecord（連鎖つき）', () => {
    makeInstall('Discord', '1.0.9256', {
      'app.asar': vcShim([VOICECORD, VENCORD]),
      '_app.asar': plain()
    })
    const st = installState(scan()[0]!)
    expect(st.state).toBe('voicecord')
    if (st.state === 'voicecord') expect(st.chain).toEqual([VOICECORD, VENCORD])
  })

  it('Vencord だけなら otherMod', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': foreign(VENCORD), '_app.asar': plain() })
    const st = installState(scan()[0]!)
    expect(st.state).toBe('otherMod')
    if (st.state === 'otherMod') expect(st.requires).toEqual([VENCORD])
  })

  it('shim なのに _app.asar が無ければ broken', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': foreign(VENCORD) })
    const st = installState(scan()[0]!)
    expect(st.state).toBe('broken')
    if (st.state === 'broken') expect(st.reason).toContain('所在が不明')
  })

  it('素なのに _app.asar が残っていれば broken', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': plain(), '_app.asar': plain() })
    expect(installState(scan()[0]!).state).toBe('broken')
  })

  it('asar として読めなければ broken', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': Buffer.alloc(40, 0xee) })
    expect(installState(scan()[0]!).state).toBe('broken')
  })
})

describe('isVoiceCordActive', () => {
  it('連鎖に VoiceCord が居るときだけ true', () => {
    makeInstall('Discord', '1.0.9256', {
      'app.asar': vcShim([VOICECORD, VENCORD]),
      '_app.asar': plain()
    })
    const install = scanInstalls(fs, { localAppData: root, join: path.join })[0]!
    expect(isVoiceCordActive(install, VOICECORD)).toBe(true)
    expect(isVoiceCordActive(install, win('C:/elsewhere/patcher.js'))).toBe(false)
  })

  it('他 mod だけなら false（＝パッチが外れている）', () => {
    makeInstall('Discord', '1.0.9256', { 'app.asar': foreign(VENCORD), '_app.asar': plain() })
    const install = scanInstalls(fs, { localAppData: root, join: path.join })[0]!
    expect(isVoiceCordActive(install, VOICECORD)).toBe(false)
  })
})
