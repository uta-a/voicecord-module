import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUDIO_EXTS,
  isInside,
  resolveSoundPath,
  scanFolder,
  type BigStatLike,
  type SoundsFs,
  type StatLike
} from '../src/patcher/soundsFs.js'

/**
 * フォルダ走査とパス検証。
 *
 * 走査の id 採番は sourceVolumes のキーそのものなので、規則を変えると
 * 既存ユーザーの音量設定が丸ごと迷子になる。回帰テストとして固定する。
 *
 * パス検証は ffmpeg を捨てた代償で入る関門。renderer が生ファイルを読む以上、
 * isolated world という閉じ方とは独立に main 側でも必ず通す。
 */

const win = (s: string): string => s.split('/').join(String.fromCharCode(92))
const FOLDER = win('C:/sounds')

interface Entry {
  kind: 'file' | 'dir'
  mtimeNs?: bigint
  size?: bigint
  /** realpath の行き先。シンボリックリンクを模す */
  real?: string
}

function fakeFs(entries: Record<string, Entry>): SoundsFs {
  const get = (p: string): Entry | undefined => entries[p]
  const stat = (p: string): StatLike => {
    const e = get(p)
    if (e === undefined) throw new Error(`ENOENT: ${p}`)
    return { isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir' }
  }
  return {
    existsSync: (p) => get(p) !== undefined,
    statSync: stat,
    statSyncBig: (p): BigStatLike => {
      const e = get(p)
      if (e === undefined || e.mtimeNs === undefined || e.size === undefined) {
        throw new Error(`stat 不可: ${p}`)
      }
      return { mtimeNs: e.mtimeNs, size: e.size }
    },
    readdirSync: (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep
      const names = new Set<string>()
      for (const key of Object.keys(entries)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '' || rest.includes(path.sep)) continue
        names.add(rest)
      }
      return [...names]
    },
    realpathSync: (p) => {
      const e = get(p)
      if (e === undefined) throw new Error(`ENOENT: ${p}`)
      return e.real ?? p
    }
  }
}

const f = (name: string, extra: Partial<Entry> = {}): [string, Entry] => [
  win(`C:/sounds/${name}`),
  { kind: 'file', mtimeNs: 111n, size: 222n, ...extra }
]

function folderWith(...files: Array<[string, Entry]>): SoundsFs {
  return fakeFs({ [FOLDER]: { kind: 'dir' }, ...Object.fromEntries(files) })
}

describe('scanFolder', () => {
  it('フォルダが空文字・不在・ファイルなら空を返す（throw しない）', () => {
    expect(scanFolder(folderWith(), '')).toEqual([])
    expect(scanFolder(folderWith(), win('C:/none'))).toEqual([])
    expect(scanFolder(fakeFs({ [FOLDER]: { kind: 'file' } }), FOLDER)).toEqual([])
  })

  it('音声の拡張子だけを拾う', () => {
    const fs = folderWith(f('a.wav'), f('b.txt'), f('c.mp3'), f('d.json'))
    expect(scanFolder(fs, FOLDER).map((s) => s.name)).toEqual(['a.wav', 'c.mp3'])
  })

  it('拡張子の大文字小文字を問わない', () => {
    const fs = folderWith(f('A.WAV'), f('B.Mp3'))
    expect(scanFolder(fs, FOLDER)).toHaveLength(2)
  })

  it('AUDIO_EXTS を全部拾う（.wma も一覧から黙って消さない）', () => {
    const fs = folderWith(...AUDIO_EXTS.map((e, i) => f(`s${i}${e}`)))
    expect(scanFolder(fs, FOLDER)).toHaveLength(AUDIO_EXTS.length)
  })

  it('ディレクトリは拾わない', () => {
    const fs = fakeFs({
      [FOLDER]: { kind: 'dir' },
      [win('C:/sounds/sub.wav')]: { kind: 'dir' },
      [win('C:/sounds/ok.wav')]: { kind: 'file' }
    })
    expect(scanFolder(fs, FOLDER).map((s) => s.name)).toEqual(['ok.wav'])
  })

  it('名前順に並べる（表示順が起動ごとに変わらない）', () => {
    const fs = folderWith(f('c.wav'), f('a.wav'), f('b.wav'))
    expect(scanFolder(fs, FOLDER).map((s) => s.name)).toEqual(['a.wav', 'b.wav', 'c.wav'])
  })

  it('id は拡張子を除いたファイル名', () => {
    const fs = folderWith(f('ドラムロール.wav'))
    expect(scanFolder(fs, FOLDER)[0]?.id).toBe('ドラムロール')
  })

  it('同名は連番。実在する base_1 とも衝突させない（sourceVolumes の取り違えを防ぐ）', () => {
    const fs = folderWith(f('boing.mp3'), f('boing.wav'), f('boing_1.mp3'))
    expect(scanFolder(fs, FOLDER).map((s) => s.id)).toEqual(['boing', 'boing_1', 'boing_1_1'])
  })

  it('同名が n 件だけなら従来どおりの規則（既存のキーを変えない）', () => {
    const fs = folderWith(f('x.mp3'), f('x.ogg'), f('x.wav'))
    expect(scanFolder(fs, FOLDER).map((s) => s.id)).toEqual(['x', 'x_1', 'x_2'])
  })

  it('内容指紋は mtimeNs_size', () => {
    const fs = folderWith(f('a.wav', { mtimeNs: 42n, size: 7n }))
    expect(scanFolder(fs, FOLDER)[0]?.fp).toBe('42_7')
  })

  it('指紋が取れなくても走査を落とさない', () => {
    const fs = folderWith(f('a.wav', { mtimeNs: undefined, size: undefined }))
    expect(scanFolder(fs, FOLDER)[0]?.fp).toBe('0')
  })

  it('path はフォルダと結合した絶対パス', () => {
    const fs = folderWith(f('a.wav'))
    expect(scanFolder(fs, FOLDER)[0]?.path).toBe(win('C:/sounds/a.wav'))
  })
})

describe('isInside', () => {
  it('配下なら true', () => {
    expect(isInside(win('C:/sounds'), win('C:/sounds/a.wav'))).toBe(true)
    expect(isInside(win('C:/sounds'), win('C:/sounds/sub/a.wav'))).toBe(true)
  })

  it('同じパスは配下ではない', () => {
    expect(isInside(win('C:/sounds'), win('C:/sounds'))).toBe(false)
  })

  it('前方一致するだけの兄弟を配下と誤判定しない', () => {
    expect(isInside(win('C:/sounds'), win('C:/sounds-secret/a.wav'))).toBe(false)
  })

  it('親や別ドライブは配下ではない', () => {
    expect(isInside(win('C:/sounds'), win('C:/a.wav'))).toBe(false)
    expect(isInside(win('C:/sounds'), win('D:/sounds/a.wav'))).toBe(false)
  })
})

describe('resolveSoundPath', () => {
  const fs = fakeFs({
    [FOLDER]: { kind: 'dir' },
    [win('C:/sounds/a.wav')]: { kind: 'file' },
    [win('C:/sounds/conf.json')]: { kind: 'file' },
    [win('C:/sounds/sub')]: { kind: 'dir' },
    // 配下に見えて実体は外を指すリンク
    [win('C:/sounds/link.wav')]: { kind: 'file', real: win('C:/secret/keys.wav') },
    [win('C:/secret/keys.wav')]: { kind: 'file' },
    [win('C:/outside.wav')]: { kind: 'file' }
  })

  it('フォルダ配下の音声ファイルは通す', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/sounds/a.wav'))).toEqual({
      ok: true,
      path: win('C:/sounds/a.wav')
    })
  })

  it('相対パスはフォルダ基準で解決する', () => {
    expect(resolveSoundPath(fs, FOLDER, 'a.wav')).toEqual({
      ok: true,
      path: win('C:/sounds/a.wav')
    })
  })

  it('フォルダの外の絶対パスは拒否する', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/outside.wav'))).toEqual({
      ok: false,
      error: '音源フォルダの外は読み取れません'
    })
  })

  it('.. で外へ出るパスを拒否する', () => {
    expect(resolveSoundPath(fs, FOLDER, win('../outside.wav')).ok).toBe(false)
  })

  it('シンボリックリンクで外を指していても拒否する（realpath で見る）', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/sounds/link.wav'))).toEqual({
      ok: false,
      error: '音源フォルダの外は読み取れません'
    })
  })

  it('音声以外はフォルダ配下でも渡さない', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/sounds/conf.json'))).toEqual({
      ok: false,
      error: '音声ファイルではありません'
    })
  })

  it('ディレクトリは渡さない', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/sounds/sub')).ok).toBe(false)
  })

  it('存在しないファイルは理由つきで断る', () => {
    expect(resolveSoundPath(fs, FOLDER, win('C:/sounds/none.wav'))).toEqual({
      ok: false,
      error: 'ファイルが見つかりません'
    })
  })

  it('フォルダ未設定・空パス・NUL 混入を断る', () => {
    expect(resolveSoundPath(fs, '', 'a.wav').ok).toBe(false)
    expect(resolveSoundPath(fs, FOLDER, '').ok).toBe(false)
    expect(resolveSoundPath(fs, FOLDER, 'a\0.wav').ok).toBe(false)
  })
})
