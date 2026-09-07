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

  // Canary は開発対象なので、パッチが当たっている状態と当たっていない状態を
  // 行き来する。どちらでも成り立つ不変条件だけを見る。
  // （当初は「未パッチであること」を書いていたが、開発でパッチを当てた途端に
  //   落ちるテストになった。実機の状態に依存する断定は書かない）
  it.skipIf(!canary)('Canary は broken ではない', () => {
    const st = installState(canary!)
    expect(['clean', 'otherMod', 'voicecord']).toContain(st.state)
  })

  it.skipIf(!canary)('Canary が未パッチなら app.asar は Discord 本体', () => {
    if (canary!.hasBackup) return
    expect(canary!.status.kind).toBe('plain')
    if (canary!.status.kind === 'plain') expect(canary!.status.size).toBeGreaterThan(1_000_000)
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

  it.skipIf(!installs.length)('active の判定が実物の連鎖と一致する', () => {
    const patcher = path.join(LOCAL, 'VoiceCord', 'dist', 'patcher.js')
    for (const i of installs) {
      const inChain =
        i.status.kind === 'shim' &&
        i.status.chain.some((p) => p.toLowerCase() === patcher.toLowerCase())
      expect(isVoiceCordActive(i, patcher)).toBe(inChain)
    }
  })
})

describe('パッチが当たっているインストール（実機）', () => {
  const patched = installs.filter((i) => i.status.kind === 'shim')

  it.skipIf(!patched.length)('必ず _app.asar に Discord 本体が退避されている', () => {
    for (const i of patched) {
      const backup = classifyAppAsar(fs, path.join(i.resourcesDir, '_app.asar'))
      expect(backup.kind).toBe('plain')
      if (backup.kind === 'plain') expect(backup.size).toBeGreaterThan(1_000_000)
    }
  })

  it.skipIf(!patched.length)('連鎖の先頭は VoiceCord の patcher', () => {
    for (const i of patched) {
      if (i.status.kind !== 'shim') continue
      // Vencord は最終行で Discord をブートし切るので、VoiceCord が後ろに
      // 回ると preload の登録が間に合わない
      expect(i.status.chain[0]?.toLowerCase()).toContain('voicecord')
    }
  })

  it.skipIf(!patched.length)('連鎖の patcher が実在する', () => {
    for (const i of patched) {
      if (i.status.kind !== 'shim') continue
      for (const p of i.status.chain) expect(fs.existsSync(p)).toBe(true)
    }
  })
})
