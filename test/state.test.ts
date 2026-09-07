import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  emptyState,
  needsReapply,
  parseStateText,
  serializeState,
  type InstallRecord
} from '../src/shared/state.js'
import {
  getInstall,
  markPatcherRun,
  readState,
  removeInstall,
  upsertInstall,
  writeState
} from '../src/shared/stateStore.js'
import { voiceCordPaths } from '../src/shared/paths.js'

const BS = String.fromCharCode(92)
const win = (s: string): string => s.split('/').join(BS)

const REC: InstallRecord = {
  branch: 'canary',
  discordVersion: '1.0.1099',
  resourcesDir: win('C:/Users/u/AppData/Local/DiscordCanary/app-1.0.1099/resources'),
  patchedAt: '2026-09-07T10:00:00.000Z',
  originalSha256: 'a'.repeat(64),
  chain: [win('C:/Users/u/AppData/Local/VoiceCord/dist/patcher.js')]
}

describe('voiceCordPaths', () => {
  it('%LOCALAPPDATA% 側に置く（旧 userData と同居させない）', () => {
    const p = voiceCordPaths(
      { localAppData: win('C:/Users/u/AppData/Local'), appData: win('C:/Users/u/AppData/Roaming') },
      path.win32.join
    )
    expect(p.root).toBe(win('C:/Users/u/AppData/Local/VoiceCord'))
    expect(p.patcher).toBe(win('C:/Users/u/AppData/Local/VoiceCord/dist/patcher.js'))
    // 旧アプリの userData は Roaming 側。ここを root にすると同居して事故る
    expect(p.legacyConfig).toBe(win('C:/Users/u/AppData/Roaming/voicecord/config.json'))
    expect(p.root.toLowerCase()).not.toBe(win('C:/Users/u/AppData/Roaming/voicecord'))
  })
})

describe('parseStateText', () => {
  it('空文字は空の状態', () => {
    expect(parseStateText('')).toEqual({ state: emptyState(), broken: false })
  })

  it('BOM つきでも読める', () => {
    const text = '\uFEFF' + serializeState(upsertInstall(emptyState(), REC))
    const { state, broken } = parseStateText(text)
    expect(broken).toBe(false)
    expect(getInstall(state, REC.resourcesDir)?.discordVersion).toBe('1.0.1099')
  })

  it('壊れた JSON は broken を立てて空の状態を返す（throw しない）', () => {
    const { state, broken } = parseStateText('{ this is not json')
    expect(broken).toBe(true)
    expect(state).toEqual(emptyState())
  })

  it('配列やスカラーも broken 扱い', () => {
    expect(parseStateText('[]').broken).toBe(true)
    expect(parseStateText('42').broken).toBe(true)
  })

  it('resourcesDir が無い記録は捨てる', () => {
    const text = JSON.stringify({ version: 1, installs: { x: { branch: 'canary' } } })
    expect(parseStateText(text).state.installs).toEqual({})
  })

  it('型が違うフィールドは既定値へ矯正し、記録ごと落とさない', () => {
    const text = JSON.stringify({
      version: 1,
      installs: {
        x: { resourcesDir: 'C:/r', branch: 42, chain: ['ok', 7, null], discordVersion: {} }
      }
    })
    const rec = parseStateText(text).state.installs['x']
    expect(rec).toBeDefined()
    expect(rec!.branch).toBe('')
    expect(rec!.discordVersion).toBe('')
    expect(rec!.chain).toEqual(['ok'])
  })

  it('キーは小文字化される（Windows は大文字小文字を区別しない）', () => {
    const text = JSON.stringify({ version: 1, installs: { 'C:/R': { resourcesDir: 'C:/R' } } })
    expect(Object.keys(parseStateText(text).state.installs)).toEqual(['c:/r'])
  })
})

describe('upsert / remove / get', () => {
  it('大文字小文字が違っても同じインストールとして扱う', () => {
    const s = upsertInstall(emptyState(), REC)
    expect(getInstall(s, REC.resourcesDir.toUpperCase())).toBeDefined()
  })

  it('他のインストールの記録を消さない', () => {
    const other: InstallRecord = { ...REC, resourcesDir: win('C:/other'), branch: 'stable' }
    const s = upsertInstall(upsertInstall(emptyState(), REC), other)
    expect(Object.keys(s.installs)).toHaveLength(2)
    const removed = removeInstall(s, REC.resourcesDir)
    expect(getInstall(removed, REC.resourcesDir)).toBeUndefined()
    expect(getInstall(removed, other.resourcesDir)).toBeDefined()
  })
})

describe('markPatcherRun', () => {
  it('記録があれば最終起動を刻む', () => {
    const s = markPatcherRun(
      upsertInstall(emptyState(), REC),
      REC.resourcesDir,
      '1.0.1100',
      '2026-09-08T00:00:00.000Z'
    )
    const rec = getInstall(s, REC.resourcesDir)!
    expect(rec.lastPatcherRunAt).toBe('2026-09-08T00:00:00.000Z')
    expect(rec.lastPatcherVersion).toBe('1.0.1100')
    // 適用時の記録は書き換えない
    expect(rec.discordVersion).toBe('1.0.1099')
  })

  it('記録が無ければ何もしない', () => {
    const s = emptyState()
    expect(markPatcherRun(s, 'C:/nope', '1.0.1', 'now')).toBe(s)
  })
})

describe('needsReapply', () => {
  it('Discord のバージョンが変わっていれば再適用が要る', () => {
    expect(needsReapply(REC, '1.0.1100')).toBe(true)
    expect(needsReapply(REC, '1.0.1099')).toBe(false)
  })

  it('記録が無い / バージョン未記録なら判断しない', () => {
    expect(needsReapply(undefined, '1.0.1')).toBe(false)
    expect(needsReapply({ ...REC, discordVersion: '' }, '1.0.1')).toBe(false)
  })
})

describe('readState / writeState', () => {
  let dir: string
  let statePath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-state-'))
    statePath = path.join(dir, 'sub', 'state.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('無ければ空の状態', () => {
    expect(readState(fs, statePath)).toEqual(emptyState())
  })

  it('書いて読み戻せる。親ディレクトリも作る', () => {
    writeState(fs, statePath, upsertInstall(emptyState(), REC), path.dirname)
    expect(getInstall(readState(fs, statePath), REC.resourcesDir)?.branch).toBe('canary')
  })

  it('一時ファイルを残さない', () => {
    writeState(fs, statePath, upsertInstall(emptyState(), REC), path.dirname)
    expect(fs.existsSync(statePath + '.tmp')).toBe(false)
  })

  it('壊れていたら .broken へ退避して空で続行する', () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, '{ broken', 'utf8')
    expect(readState(fs, statePath)).toEqual(emptyState())
    expect(fs.readFileSync(statePath + '.broken', 'utf8')).toBe('{ broken')
  })
})
