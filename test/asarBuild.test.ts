import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as asar from '@electron/asar'
import { buildFlatAsar } from '../src/manager/patch/asarBuild.js'
import { classifyAppAsar, readAsar, readTopLevelFile } from '../src/manager/patch/asarInspect.js'
import { renderShimSource, SHIM_PACKAGE_JSON } from '../src/manager/patch/shimSource.js'

const BS = String.fromCharCode(92)
const win = (s: string): string => s.split('/').join(BS)

describe('buildFlatAsar', () => {
  it('自前リーダで往復できる', () => {
    const buf = buildFlatAsar({ 'index.js': 'hello', 'package.json': '{"a":1}' })
    const p = writeTmp(buf)
    const view = readAsar(fs, p)
    expect(readTopLevelFile(view, 'index.js')).toBe('hello')
    expect(readTopLevelFile(view, 'package.json')).toBe('{"a":1}')
  })

  it('ヘッダ長が 4 の倍数でなくてもずれない（パディングの検証）', () => {
    // 中身の長さを 1 バイトずつ変えて、ヘッダ JSON 長の剰余を一巡させる
    for (let n = 1; n <= 8; n++) {
      const body = 'x'.repeat(n)
      const buf = buildFlatAsar({ 'a.js': body, 'b.js': 'TAIL' })
      const p = writeTmp(buf)
      const view = readAsar(fs, p)
      expect(readTopLevelFile(view, 'a.js')).toBe(body)
      expect(readTopLevelFile(view, 'b.js')).toBe('TAIL')
    }
  })

  it('@electron/asar が読める形式になっている（本物との互換性）', () => {
    const source = renderShimSource([win('C:/VoiceCord/patcher.js')])
    const buf = buildFlatAsar({ 'index.js': source, 'package.json': SHIM_PACKAGE_JSON })
    const p = writeTmp(buf)
    expect(asar.listPackage(p, { isPack: false }).sort()).toEqual([
      path.sep + 'index.js',
      path.sep + 'package.json'
    ])
    expect(asar.extractFile(p, 'index.js').toString('utf8')).toBe(source)
    expect(asar.extractFile(p, 'package.json').toString('utf8')).toBe(SHIM_PACKAGE_JSON)
  })

  it('組み立てた shim が shim として判定される（往復）', () => {
    const chain = [win('C:/VoiceCord/patcher.js'), win('C:/Vencord/patcher.js')]
    const buf = buildFlatAsar({
      'index.js': renderShimSource(chain),
      'package.json': SHIM_PACKAGE_JSON
    })
    const got = classifyAppAsar(fs, writeTmp(buf))
    expect(got.kind).toBe('shim')
    if (got.kind === 'shim') expect(got.chain).toEqual(chain)
  })

  it('実機の Vencord shim と同じヘッダ構造になる', () => {
    // 実機（Discord Stable 1.0.9256）の app.asar は 219 バイトで、
    // index.js 72 バイト + package.json 43 バイト、ヘッダ文字列長 88、本体開始 104。
    // 同じ内容を組み立てたときに同じレイアウトになることを確認する。
    const indexJs = `require("${win('C:/Users/utaaa/AppData/Roaming/Vencord/dist/patcher.js').split(BS).join(BS + BS)}")`
    const pkg = `{\n\t"name": "discord",\n\t"main": "index.js"\n}`
    const buf = buildFlatAsar({ 'index.js': indexJs, 'package.json': pkg })
    expect(buf.readUInt32LE(0)).toBe(4)
    expect(buf.readUInt32LE(4)).toBe(8 + buf.readUInt32LE(8) - 4)
    expect(8 + buf.readUInt32LE(4)).toBe(16 + align4(buf.readUInt32LE(12)))
    expect(buf.length).toBe(8 + buf.readUInt32LE(4) + indexJs.length + pkg.length)
  })
})

function align4(n: number): number {
  return (n + 3) & ~3
}

let counter = 0
function writeTmp(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-build-'))
  const p = path.join(dir, `t${counter++}.asar`)
  fs.writeFileSync(p, buf)
  return p
}
