import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { classifyAppAsar } from '../src/manager/patch/asarInspect.js'

/**
 * 実機の Discord インストールに対する統合テスト。
 * 判定ロジックが「合成した asar」ではなく「本物」で正しく効くことを確認する。
 * 該当ビルドが入っていない環境では自動的にスキップされる。
 */

const LOCAL = process.env['LOCALAPPDATA'] ?? ''

/** 指定ブランチの最新 app-<version>/resources を返す。無ければ null。 */
function newestResources(branch: string): string | null {
  if (!LOCAL) return null
  const root = path.join(LOCAL, branch)
  if (!fs.existsSync(root)) return null
  const apps = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('app-'))
    .sort()
  const last = apps[apps.length - 1]
  if (last === undefined) return null
  const res = path.join(root, last, 'resources')
  return fs.existsSync(res) ? res : null
}

const stable = newestResources('Discord')
const canary = newestResources('DiscordCanary')

describe('実機の Discord インストール', () => {
  it.skipIf(!canary)('Canary の app.asar は素の Discord (plain) と判定される', () => {
    const got = classifyAppAsar(fs, path.join(canary!, 'app.asar'))
    expect(got.kind).toBe('plain')
    if (got.kind === 'plain') expect(got.size).toBeGreaterThan(1_000_000)
  })

  it.skipIf(!canary)('Canary には _app.asar が無い（未パッチ）', () => {
    expect(classifyAppAsar(fs, path.join(canary!, '_app.asar'))).toEqual({ kind: 'missing' })
  })

  it.skipIf(!stable)('Stable の app.asar は他 mod の shim (foreignShim) と判定される', () => {
    const appAsar = path.join(stable!, 'app.asar')
    const underscore = path.join(stable!, '_app.asar')
    // Vencord が入っていない環境では plain になるので、その場合はこの検証を飛ばす
    if (!fs.existsSync(underscore)) {
      expect(classifyAppAsar(fs, appAsar).kind).toBe('plain')
      return
    }
    const got = classifyAppAsar(fs, appAsar)
    expect(got.kind).toBe('foreignShim')
    if (got.kind === 'foreignShim') {
      expect(got.size).toBeLessThan(10_000)
      // shim は必ず何かを require している。空なら抽出ロジックが壊れている。
      expect(got.requires.length).toBeGreaterThan(0)
    }
  })

  it.skipIf(!stable)('Stable の _app.asar は素の Discord 本体', () => {
    const underscore = path.join(stable!, '_app.asar')
    if (!fs.existsSync(underscore)) return
    const got = classifyAppAsar(fs, underscore)
    expect(got.kind).toBe('plain')
    if (got.kind === 'plain') expect(got.size).toBeGreaterThan(1_000_000)
  })
})
