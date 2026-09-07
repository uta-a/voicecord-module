import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { classifyAppAsar } from '../src/manager/patch/asarInspect.js'
import { installState, isVoiceCordActive, scanInstalls } from '../src/manager/patch/scan.js'

/**
 * 実機の Discord インストールに対する統合テスト。
 * 判定ロジックが「合成した asar」ではなく「本物」で正しく効くことを確認する。
 * 該当ビルドが入っていない環境では自動的にスキップされる。
 */

const LOCAL = process.env['LOCALAPPDATA'] ?? ''
const installs = LOCAL ? scanInstalls(fs, { localAppData: LOCAL, join: path.join }) : []
const byBranch = new Map(installs.map((i) => [i.spec.branch, i]))
const stable = byBranch.get('stable')
const canary = byBranch.get('canary')

describe('実機の Discord インストール', () => {
  it.skipIf(!LOCAL)('走査結果は必ず resources を持つ', () => {
    for (const i of installs) {
      expect(fs.existsSync(i.resourcesDir)).toBe(true)
      expect(i.version).toMatch(/^\d/)
    }
  })

  it.skipIf(!canary)('Canary の app.asar は素の Discord (plain)', () => {
    expect(canary!.status.kind).toBe('plain')
    if (canary!.status.kind === 'plain') expect(canary!.status.size).toBeGreaterThan(1_000_000)
  })

  it.skipIf(!canary)('Canary は未パッチ (clean)', () => {
    expect(canary!.hasBackup).toBe(false)
    expect(installState(canary!)).toEqual({ state: 'clean' })
  })

  it.skipIf(!stable)('Stable は素か、他 mod 入りか、VoiceCord 入りのいずれか（broken でない）', () => {
    const st = installState(stable!)
    expect(['clean', 'otherMod', 'voicecord']).toContain(st.state)
  })

  it.skipIf(!stable)('Stable に mod が入っているなら _app.asar が Discord 本体', () => {
    if (!stable!.hasBackup) return
    const got = classifyAppAsar(fs, path.join(stable!.resourcesDir, '_app.asar'))
    expect(got.kind).toBe('plain')
    if (got.kind === 'plain') expect(got.size).toBeGreaterThan(1_000_000)
  })

  it.skipIf(!stable)('他 mod の shim なら require 先を必ず 1 つ以上拾える', () => {
    const st = installState(stable!)
    if (st.state !== 'otherMod') return
    // 空なら抽出ロジックが壊れている
    expect(st.requires.length).toBeGreaterThan(0)
    expect(st.requires.every((p) => p.length > 0)).toBe(true)
  })

  it.skipIf(!installs.length)('VoiceCord は未導入なので、どのインストールでも非アクティブ', () => {
    // 実装が進んで実際に適用したら、このテストは期待値を変える必要がある
    const fake = path.join(LOCAL, 'VoiceCord', 'dist', 'patcher.js')
    if (fs.existsSync(fake)) return
    for (const i of installs) expect(isVoiceCordActive(i, fake)).toBe(false)
  })
})
