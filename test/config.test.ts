import { describe, expect, it } from 'vitest'
import {
  createConfigStore,
  defaultConfig,
  defaultSoundsFolder,
  loadConfig,
  parseConfigText,
  saveConfigFile,
  type ConfigFs
} from '../src/shared/config.js'

/**
 * 設定の読み書き。
 *
 * ここで守っているのは実事故から生まれた 3 点（BOM・.broken 退避・tmp→rename）と、
 * 旧 Electron アプリからの非破壊移行。どれも「黙って設定が消える」に直結する。
 */

/** バックスラッシュを JSON エスケープの都合から切り離す */
const win = (s: string): string => s.split('/').join(String.fromCharCode(92))

const CONFIG = win('C:/Users/u/AppData/Local/VoiceCord/config.json')
const LEGACY = win('C:/Users/u/AppData/Roaming/voicecord/config.json')
const PATHS = { config: CONFIG, legacyConfig: LEGACY }
const DFLT = defaultConfig(win('C:/Users/u/Documents/VoiceCord/sounds'))

const dirname = (p: string): string => p.slice(0, p.lastIndexOf(String.fromCharCode(92)))

interface FakeFs extends ConfigFs {
  files: Map<string, string>
  mkdirs: string[]
}

function fakeFs(initial: Record<string, string> = {}, opts: { failWrite?: string } = {}): FakeFs {
  const files = new Map(Object.entries(initial))
  const mkdirs: string[] = []
  const fs: FakeFs = {
    files,
    mkdirs,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeFileSync: (p, data) => {
      if (opts.failWrite !== undefined && p === opts.failWrite) throw new Error('書き込み失敗')
      files.set(p, data)
    },
    renameSync: (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, v)
    },
    unlinkSync: (p) => void files.delete(p),
    mkdirSync: (p) => void mkdirs.push(p)
  }
  return fs
}

describe('parseConfigText', () => {
  it('UTF-8 BOM が付いていても読める（メモ帳や Set-Content -Encoding utf8 で付く）', () => {
    const text = '\ufeff' + JSON.stringify({ master: 1.2 })
    const { config, error } = parseConfigText(text, DFLT)
    expect(error).toBeNull()
    expect(config.master).toBe(1.2)
  })

  it('壊れた JSON は理由つきで既定値を返す', () => {
    const { config, error } = parseConfigText('{ master: ', DFLT)
    expect(error).toMatch(/設定ファイルを読み取れませんでした/)
    expect(config).toEqual(DFLT)
  })

  it('配列や null は形式違いとして弾く', () => {
    expect(parseConfigText('[]', DFLT).error).toMatch(/形式が想定と違いました/)
    expect(parseConfigText('null', DFLT).error).toMatch(/形式が想定と違いました/)
  })

  it('範囲外の数値を矯正する', () => {
    const { config } = parseConfigText(
      JSON.stringify({ master: 99, sidetoneVolume: -1, entryDelayMs: 999_999 }),
      DFLT
    )
    expect(config.master).toBe(4)
    expect(config.sidetoneVolume).toBe(0)
    expect(config.entryDelayMs).toBe(10_000)
  })

  it('数値でない値は既定に戻す（NaN が hook.js まで流れない）', () => {
    const { config } = parseConfigText(JSON.stringify({ master: 'あ', entryDelayMs: null }), DFLT)
    expect(config.master).toBe(DFLT.master)
    expect(config.entryDelayMs).toBe(DFLT.entryDelayMs)
  })

  it('音源別音量は非数値を落として 0〜1.5 に収める', () => {
    const { config } = parseConfigText(
      JSON.stringify({ sourceVolumes: { a: 0.5, b: 'x', c: 9, d: -2 } }),
      DFLT
    )
    expect(config.sourceVolumes).toEqual({ a: 0.5, c: 1.5, d: 0 })
  })

  it('sourceVolumes が object でなければ空にする', () => {
    expect(parseConfigText(JSON.stringify({ sourceVolumes: [1, 2] }), DFLT).config.sourceVolumes)
      .toEqual({})
    expect(parseConfigText(JSON.stringify({ sourceVolumes: null }), DFLT).config.sourceVolumes)
      .toEqual({})
  })

  it('folder が空文字や非文字列なら既定へ戻す', () => {
    expect(parseConfigText(JSON.stringify({ folder: '' }), DFLT).config.folder).toBe(DFLT.folder)
    expect(parseConfigText(JSON.stringify({ folder: 3 }), DFLT).config.folder).toBe(DFLT.folder)
  })

  it('校正値と音源別音量はそのまま引き継ぐ（再校正を強いない）', () => {
    const calibration = { at: 1, voiceRms: 0.081, voicePeak: 0.393, activeRatio: 1, targetDb: -8 }
    const { config } = parseConfigText(
      JSON.stringify({ calibration, sourceVolumes: { x: 0.9 } }),
      DFLT
    )
    expect(config.calibration).toEqual(calibration)
    expect(config.sourceVolumes).toEqual({ x: 0.9 })
  })
})

describe('loadConfig', () => {
  it('どちらも無ければ既定値。警告も移行も無い', () => {
    const r = loadConfig(fakeFs(), PATHS, DFLT)
    expect(r).toEqual({ config: DFLT, warning: null, migratedFrom: null })
  })

  it('現行があれば旧設定は見に行かない', () => {
    const fs = fakeFs({
      [CONFIG]: JSON.stringify({ master: 1.1 }),
      [LEGACY]: JSON.stringify({ master: 2.2 })
    })
    const r = loadConfig(fs, PATHS, DFLT)
    expect(r.config.master).toBe(1.1)
    expect(r.migratedFrom).toBeNull()
  })

  it('現行が無ければ旧設定から読み、移行元を報告する', () => {
    const fs = fakeFs({ [LEGACY]: JSON.stringify({ master: 2.2, sourceVolumes: { a: 0.3 } }) })
    const r = loadConfig(fs, PATHS, DFLT)
    expect(r.config.master).toBe(2.2)
    expect(r.config.sourceVolumes).toEqual({ a: 0.3 })
    expect(r.migratedFrom).toBe(LEGACY)
  })

  it('壊れていたら .broken へ退避して既定値。退避先を警告に出す', () => {
    const fs = fakeFs({ [CONFIG]: '{ broken' })
    const r = loadConfig(fs, PATHS, DFLT)
    expect(r.config).toEqual(DFLT)
    expect(fs.files.has(`${CONFIG}.broken`)).toBe(true)
    expect(fs.files.has(CONFIG)).toBe(false)
    expect(r.warning).toContain('.broken')
  })

  it('退避に失敗しても既定値で続行し、その旨を出す', () => {
    const fs = fakeFs({ [CONFIG]: '{ broken' })
    fs.renameSync = () => {
      throw new Error('使用中')
    }
    const r = loadConfig(fs, PATHS, DFLT)
    expect(r.config).toEqual(DFLT)
    expect(r.warning).toContain('初期値に戻りました')
    expect(r.warning).not.toContain('.broken')
  })

  it('読み取り自体が失敗しても throw しない', () => {
    const fs = fakeFs({ [CONFIG]: 'x' })
    fs.readFileSync = () => {
      throw new Error('EACCES')
    }
    const r = loadConfig(fs, PATHS, DFLT)
    expect(r.config).toEqual(DFLT)
    expect(r.warning).toContain('EACCES')
  })
})

describe('saveConfigFile', () => {
  it('tmp へ書いてから rename する（途中で落ちても壊れた config を残さない）', () => {
    const fs = fakeFs()
    const order: string[] = []
    const write = fs.writeFileSync
    fs.writeFileSync = (p, d, enc) => {
      order.push(`write ${p}`)
      write(p, d, enc)
    }
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      order.push(`rename ${from} -> ${to}`)
      rename(from, to)
    }

    expect(saveConfigFile(fs, CONFIG, DFLT, dirname)).toEqual({ ok: true })
    expect(order).toEqual([`write ${CONFIG}.tmp`, `rename ${CONFIG}.tmp -> ${CONFIG}`])
    expect(JSON.parse(fs.files.get(CONFIG) as string)).toEqual(DFLT)
  })

  it('保存先のディレクトリを作る', () => {
    const fs = fakeFs()
    saveConfigFile(fs, CONFIG, DFLT, dirname)
    expect(fs.mkdirs).toEqual([dirname(CONFIG)])
  })

  it('失敗したら理由を返し、書きかけの tmp を残さない', () => {
    const fs = fakeFs({}, { failWrite: `${CONFIG}.tmp` })
    const r = saveConfigFile(fs, CONFIG, DFLT, dirname)
    expect(r).toEqual({ ok: false, error: '書き込み失敗' })
    expect(fs.files.has(`${CONFIG}.tmp`)).toBe(false)
    expect(fs.files.has(CONFIG)).toBe(false)
  })
})

describe('createConfigStore', () => {
  it('旧設定を新しい場所へ書き出し、旧ファイルは消さない', () => {
    const fs = fakeFs({
      [LEGACY]: JSON.stringify({ master: 2.2, sourceVolumes: { a: 0.3 }, calibration: null })
    })
    const store = createConfigStore(fs, PATHS, DFLT, dirname)

    expect(store.get().master).toBe(2.2)
    expect(fs.files.has(CONFIG)).toBe(true)
    // 旧ファイルが消えていないこと。ここが移行の非破壊性そのもの
    expect(fs.files.has(LEGACY)).toBe(true)
  })

  it('移行したことを必ず警告に出す（無言で移行しない）', () => {
    const fs = fakeFs({ [LEGACY]: JSON.stringify({ master: 2.2 }) })
    const store = createConfigStore(fs, PATHS, DFLT, dirname)
    expect(store.loadWarning).toContain(LEGACY)
    expect(store.loadWarning).toContain('残してあります')
  })

  it('移行の書き出しに失敗しても値は使い、失敗を報告する', () => {
    const fs = fakeFs({ [LEGACY]: JSON.stringify({ master: 2.2 }) }, { failWrite: `${CONFIG}.tmp` })
    const store = createConfigStore(fs, PATHS, DFLT, dirname)
    expect(store.get().master).toBe(2.2)
    expect(store.loadWarning).toContain('保存できませんでした')
  })

  it('正常なら警告は出さない', () => {
    const fs = fakeFs({ [CONFIG]: JSON.stringify({ master: 1.0 }) })
    expect(createConfigStore(fs, PATHS, DFLT, dirname).loadWarning).toBeNull()
  })

  it('部分更新は他のフィールドを壊さない', () => {
    const fs = fakeFs({ [CONFIG]: JSON.stringify({ master: 1.0, sourceVolumes: { a: 0.5 } }) })
    const store = createConfigStore(fs, PATHS, DFLT, dirname)
    store.save({ master: 2.0 })
    expect(store.get().sourceVolumes).toEqual({ a: 0.5 })
    expect(JSON.parse(fs.files.get(CONFIG) as string).master).toBe(2.0)
  })

  it('保存に失敗しても在庫の値は更新する（UI を固まらせない）', () => {
    const fs = fakeFs({ [CONFIG]: JSON.stringify({ master: 1.0 }) }, { failWrite: `${CONFIG}.tmp` })
    const store = createConfigStore(fs, PATHS, DFLT, dirname)
    const r = store.save({ master: 3.0 })
    expect(r.ok).toBe(false)
    expect(store.get().master).toBe(3.0)
  })
})

describe('defaultSoundsFolder', () => {
  it('%USERPROFILE%\\Documents\\VoiceCord\\sounds', () => {
    const join = (...p: string[]): string => p.join(String.fromCharCode(92))
    expect(defaultSoundsFolder(win('C:/Users/u'), join)).toBe(
      win('C:/Users/u/Documents/VoiceCord/sounds')
    )
  })
})
