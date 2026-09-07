import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPatch, planPatch, sha256, targetFor, unpatch, type PatchTarget } from '../src/manager/patch/apply.js'
import { buildFlatAsar } from '../src/manager/patch/asarBuild.js'
import { classifyAppAsar } from '../src/manager/patch/asarInspect.js'
import { SHIM_PACKAGE_JSON } from '../src/manager/patch/shimSource.js'

const BS = String.fromCharCode(92)
const win = (s: string): string => s.split('/').join(BS)

const VOICECORD = win('C:/Users/u/AppData/Local/VoiceCord/dist/patcher.js')
const VENCORD = win('C:/Users/u/AppData/Roaming/Vencord/dist/patcher.js')
const OTHER = win('C:/Users/u/AppData/Roaming/OtherMod/patcher.js')

/** 素の Discord app.asar に見えるダミー（bundle.js を含む） */
function plainAsar(marker = 'original'): Buffer {
  return buildFlatAsar({
    'bundle.js': `console.log(${JSON.stringify(marker)});` + 'x'.repeat(200),
    'package.json': '{"name":"discord","main":"bundle.js"}'
  })
}

/** Vencord 形式の shim（VoiceCord のマーカーを持たない） */
function foreignShim(requirePath: string): Buffer {
  return buildFlatAsar({
    'index.js': `require(${JSON.stringify(requirePath)})`,
    'package.json': SHIM_PACKAGE_JSON
  })
}

let dir: string
let t: PatchTarget

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-apply-'))
  t = targetFor(dir, path.join)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('planPatch — 弾くべきケース', () => {
  it('app.asar が無ければ弾く', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('見つかりません')
  })

  it('asar として読めないファイルは弾く（触らない）', () => {
    fs.writeFileSync(t.appAsar, Buffer.alloc(64, 0xff))
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('想定外')
  })

  it('shim なのに _app.asar が無ければ弾く（本体の所在が不明）', () => {
    fs.writeFileSync(t.appAsar, foreignShim(VENCORD))
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('所在が不明')
  })

  it('_app.asar が Discord 本体でなければ弾く', () => {
    fs.writeFileSync(t.appAsar, foreignShim(VENCORD))
    fs.writeFileSync(t.backupAsar, foreignShim(VENCORD))
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('Discord 本体ではありません')
  })
})

describe('applyPatch — 素の Discord（Canary 相当）', () => {
  beforeEach(() => fs.writeFileSync(t.appAsar, plainAsar()))

  it('_app.asar を作り、app.asar を VoiceCord 単独の shim にする', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.needsBackup).toBe(true)
    expect(plan.chain).toEqual([VOICECORD])

    const res = applyPatch(fs, t, plan)
    expect(res.backedUp).toBe(true)

    const after = classifyAppAsar(fs, t.appAsar)
    expect(after.kind).toBe('shim')
    if (after.kind === 'shim') expect(after.chain).toEqual([VOICECORD])
    expect(classifyAppAsar(fs, t.backupAsar).kind).toBe('plain')
  })

  it('ディスク上に Vencord があっても、勝手に連鎖へ足さない', () => {
    // Vencord が入っていないインストールに注入するのは筋が悪い。
    // 引き継ぐのは「既にそのインストールに入っていたもの」だけ。
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')
    expect(plan.chain).toEqual([VOICECORD])
  })

  it('extraChain で明示指定したものは足す（Canary での連鎖テスト用）', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD, extraChain: [VENCORD] })
    if (!plan.ok) throw new Error('plan failed')
    expect(plan.chain).toEqual([VOICECORD, VENCORD])
    applyPatch(fs, t, plan)
    const after = classifyAppAsar(fs, t.appAsar)
    if (after.kind === 'shim') expect(after.chain).toEqual([VOICECORD, VENCORD])
  })

  it('一時ファイルを残さない', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')
    applyPatch(fs, t, plan)
    expect(fs.existsSync(t.tmpFile)).toBe(false)
  })
})

describe('applyPatch — Vencord 済み（Stable 相当）', () => {
  let originalSha: string
  beforeEach(() => {
    const original = plainAsar()
    originalSha = sha256(original)
    fs.writeFileSync(t.backupAsar, original)
    fs.writeFileSync(t.appAsar, foreignShim(VENCORD))
  })

  it('Vencord を引き継ぎ、VoiceCord を先頭に置く', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.needsBackup).toBe(false)
    expect(plan.preserved).toEqual([VENCORD])
    expect(plan.chain).toEqual([VOICECORD, VENCORD])

    const res = applyPatch(fs, t, plan)
    // Vencord は最終行で Discord をブートするので、必ず VoiceCord より後
    expect(res.chain[0]).toBe(VOICECORD)
    expect(res.chain[1]).toBe(VENCORD)
    expect(res.originalSha256).toBe(originalSha)
    expect(res.backedUp).toBe(false)
  })

  it('_app.asar を上書きしない（Discord 本体を守る）', () => {
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')
    applyPatch(fs, t, plan)
    expect(sha256(fs.readFileSync(t.backupAsar))).toBe(originalSha)
  })

  it('再適用しても連鎖が重複しない（冪等）', () => {
    const p1 = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!p1.ok) throw new Error('plan failed')
    applyPatch(fs, t, p1)

    const p2 = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!p2.ok) throw new Error('replan failed')
    expect(p2.chain).toEqual([VOICECORD, VENCORD])
    applyPatch(fs, t, p2)

    const after = classifyAppAsar(fs, t.appAsar)
    if (after.kind === 'shim') expect(after.chain).toEqual([VOICECORD, VENCORD])
  })

  it('他 mod が複数あっても全部引き継ぐ', () => {
    fs.writeFileSync(
      t.appAsar,
      buildFlatAsar({
        'index.js': `require(${JSON.stringify(VENCORD)});require(${JSON.stringify(OTHER)})`,
        'package.json': SHIM_PACKAGE_JSON
      })
    )
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')
    expect(plan.chain).toEqual([VOICECORD, VENCORD, OTHER])
  })
})

describe('unpatch', () => {
  let original: Buffer
  beforeEach(() => {
    original = plainAsar()
    fs.writeFileSync(t.backupAsar, original)
    fs.writeFileSync(t.appAsar, foreignShim(VENCORD))
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('setup plan failed')
    applyPatch(fs, t, plan)
  })

  it('voicecordOnly は Vencord を残す', () => {
    const res = unpatch(fs, t, 'voicecordOnly', VOICECORD)
    expect(res.restored).toBe(false)
    expect(res.remaining).toEqual([VENCORD])
    const after = classifyAppAsar(fs, t.appAsar)
    expect(after.kind).toBe('shim')
    if (after.kind === 'shim') expect(after.chain).toEqual([VENCORD])
    expect(fs.existsSync(t.backupAsar)).toBe(true)
  })

  it('full は素の Discord に戻し、_app.asar を消す', () => {
    const res = unpatch(fs, t, 'full', VOICECORD)
    expect(res.restored).toBe(true)
    expect(classifyAppAsar(fs, t.appAsar).kind).toBe('plain')
    expect(fs.existsSync(t.backupAsar)).toBe(false)
    // バイト単位で元に戻っている
    expect(sha256(fs.readFileSync(t.appAsar))).toBe(sha256(original))
  })

  it('VoiceCord 単独だった場合は voicecordOnly でも素に戻る', () => {
    unpatch(fs, t, 'full', VOICECORD) // いったん素に戻す
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')
    applyPatch(fs, t, plan)

    const res = unpatch(fs, t, 'voicecordOnly', VOICECORD)
    expect(res.restored).toBe(true)
    expect(classifyAppAsar(fs, t.appAsar).kind).toBe('plain')
    expect(sha256(fs.readFileSync(t.appAsar))).toBe(sha256(original))
  })

  it('既に素なら何もしない', () => {
    unpatch(fs, t, 'full', VOICECORD)
    const res = unpatch(fs, t, 'full', VOICECORD)
    expect(res.restored).toBe(false)
    expect(classifyAppAsar(fs, t.appAsar).kind).toBe('plain')
  })

  it('適用と解除を 3 往復してもバイト単位で元に戻る', () => {
    for (let i = 0; i < 3; i++) {
      unpatch(fs, t, 'full', VOICECORD)
      expect(sha256(fs.readFileSync(t.appAsar))).toBe(sha256(original))
      const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
      if (!plan.ok) throw new Error(`plan failed at ${i}`)
      applyPatch(fs, t, plan)
      expect(classifyAppAsar(fs, t.appAsar).kind).toBe('shim')
    }
    unpatch(fs, t, 'full', VOICECORD)
    expect(sha256(fs.readFileSync(t.appAsar))).toBe(sha256(original))
  })

  it('_app.asar が壊れていたら解除を拒む', () => {
    fs.writeFileSync(t.backupAsar, Buffer.alloc(32, 0))
    expect(() => unpatch(fs, t, 'full', VOICECORD)).toThrow(/Discord 本体ではありません/)
  })
})

describe('applyPatch — 途中の状態', () => {
  it('計画時から app.asar が変わっていたら実行を拒む', () => {
    fs.writeFileSync(t.appAsar, plainAsar())
    const plan = planPatch(fs, t, { voicecordPatcher: VOICECORD })
    if (!plan.ok) throw new Error('plan failed')

    // 計画のあとで他の何かがパッチしたことにする
    fs.writeFileSync(t.backupAsar, plainAsar())
    fs.writeFileSync(t.appAsar, foreignShim(VENCORD))

    expect(() => applyPatch(fs, t, plan)).toThrow(/状態が計画時/)
  })
})
