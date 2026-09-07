import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as asar from '@electron/asar'
import { classifyAppAsar, extractRequirePaths, readAsar, readTopLevelFile, topLevelNames } from '../src/manager/patch/asarInspect.js'
import { renderShimSource, SHIM_PACKAGE_JSON } from '../src/manager/patch/shimSource.js'

const BS = String.fromCharCode(92)
const win = (s: string): string => s.split('/').join(BS)

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-asar-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** files の内容から asar を 1 個作って、そのパスを返す */
async function makeAsar(name: string, files: Record<string, string>): Promise<string> {
  const src = path.join(tmp, `src-${name}`)
  fs.mkdirSync(src, { recursive: true })
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(src, f), content)
  const dest = path.join(tmp, `${name}.asar`)
  await asar.createPackageWithOptions(src, dest, {})
  return dest
}

describe('classifyAppAsar', () => {
  it('存在しないファイルは missing', () => {
    expect(classifyAppAsar(fs, path.join(tmp, 'nope.asar'))).toEqual({ kind: 'missing' })
  })

  it('bundle.js を含むものは素の Discord (plain)', async () => {
    const p = await makeAsar('plain', { 'bundle.js': 'console.log(1)', 'package.json': '{}' })
    const got = classifyAppAsar(fs, p)
    expect(got.kind).toBe('plain')
  })

  it('VoiceCord の shim を shim として認識し、連鎖を読み出せる', async () => {
    const chain = [win('C:/VoiceCord/patcher.js'), win('C:/Vencord/patcher.js')]
    const p = await makeAsar('vcshim', {
      'index.js': renderShimSource(chain),
      'package.json': SHIM_PACKAGE_JSON
    })
    const got = classifyAppAsar(fs, p)
    expect(got.kind).toBe('shim')
    if (got.kind === 'shim') expect(got.chain).toEqual(chain)
  })

  it('Vencord 形式の shim は foreignShim として認識し、require 先を拾う', async () => {
    const vencord = win('C:/Users/utaaa/AppData/Roaming/Vencord/dist/patcher.js')
    const p = await makeAsar('vcdshim', {
      'index.js': `require(${JSON.stringify(vencord)})`,
      'package.json': SHIM_PACKAGE_JSON
    })
    const got = classifyAppAsar(fs, p)
    expect(got.kind).toBe('foreignShim')
    if (got.kind === 'foreignShim') expect(got.requires).toEqual([vencord])
  })

  it('想定外の中身は unknown（理由つき）', async () => {
    const p = await makeAsar('weird', { 'something.txt': 'hello' })
    const got = classifyAppAsar(fs, p)
    expect(got.kind).toBe('unknown')
    if (got.kind === 'unknown') expect(got.reason).toContain('something.txt')
  })

  it('asar ですらないファイルは unknown（throw しない）', () => {
    const p = path.join(tmp, 'garbage.asar')
    fs.writeFileSync(p, Buffer.alloc(64, 0xff))
    const got = classifyAppAsar(fs, p)
    expect(got.kind).toBe('unknown')
  })

  it('空ファイルでも throw しない', () => {
    const p = path.join(tmp, 'empty.asar')
    fs.writeFileSync(p, Buffer.alloc(0))
    expect(classifyAppAsar(fs, p).kind).toBe('unknown')
  })
})

describe('extractRequirePaths', () => {
  it('組み込みモジュールの require は拾わない', () => {
    const src = `var path = require("path"), fs = require("fs"); require(${JSON.stringify(win('C:/a/b.js'))})`
    expect(extractRequirePaths(src)).toEqual([win('C:/a/b.js')])
  })
})
