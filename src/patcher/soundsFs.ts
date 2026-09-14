import path from 'node:path'
import type { SoundItem } from '../shared/types.js'

/**
 * サウンドフォルダの走査と、renderer へ生ファイルを渡すときのパス検証。
 *
 * 移植元（desktop/src/main/engine/audio.ts）から `scanFolder` だけを持ってくる。
 * ffmpeg 変換とディスクキャッシュは M4 で廃止するので連れてこない。
 *
 * `resolveSoundPath` は新規。ffmpeg を捨てた代償として renderer が生ファイルを
 * 読むようになるため、「設定中のフォルダ配下の音声ファイルだけ」に閉じる関門が要る。
 */

export const AUDIO_EXTS = [
  '.f32',
  '.wav',
  '.mp3',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.opus',
  '.wma',
  '.aiff'
] as const

export interface StatLike {
  isFile(): boolean
  isDirectory(): boolean
}

export interface BigStatLike {
  mtimeNs: bigint
  size: bigint
}

export interface SoundsFs {
  existsSync(p: string): boolean
  statSync(p: string): StatLike
  /** 内容指紋のために ns 精度で取る。取れなければ throw してよい */
  statSyncBig(p: string): BigStatLike
  readdirSync(p: string): string[]
  /** シンボリックリンクとジャンクションを解決する。存在しなければ throw */
  realpathSync(p: string): string
}

function isAudio(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return (AUDIO_EXTS as readonly string[]).includes(ext)
}

/**
 * フォルダ直下の音声ファイルを列挙する。id は拡張子を除いたファイル名。
 *
 * id は sourceVolumes のキーであり入場音の指定でもある。衝突すると別の音源が
 * 同じ音量設定を掴み、タイルを押しても先頭の音が鳴る。そのため「払い出し済みの
 * id」を集合で持ち、実在する `base_1.mp3` と当たったときはさらに先へ進める
 * （同名が n 件だけなら従来どおり base, base_1, base_2 … になるので、
 * 既存ユーザーの sourceVolumes のキーは変わらない）。
 */
export function scanFolder(fs: SoundsFs, folder: string): SoundItem[] {
  const items: SoundItem[] = []
  if (folder === '') return items
  try {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return items
  } catch {
    return items
  }

  let names: string[]
  try {
    names = [...fs.readdirSync(folder)].sort()
  } catch {
    return items
  }

  const used = new Set<string>()
  for (const name of names) {
    const p = path.isAbsolute(name) ? name : path.join(folder, name)
    try {
      if (!fs.statSync(p).isFile()) continue
    } catch {
      continue
    }
    if (!isAudio(name)) continue

    const base = path.basename(name, path.extname(name))
    let id = base
    let seq = 0
    while (used.has(id)) {
      seq += 1
      id = `${base}_${seq}`
    }
    used.add(id)

    // 内容指紋。同名で差し替えても値が変わるので、キャッシュの取り違えを防げる
    let fp = '0'
    try {
      const st = fs.statSyncBig(p)
      fp = `${st.mtimeNs}_${st.size}`
    } catch {
      // 取れなければ既定値のまま。走査ごと落とすほどのことではない
    }

    items.push({ id, name, path: path.join(folder, name), fp, kind: 'file' })
  }
  return items
}

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * renderer から渡されたパスを検証して実パスに直す。
 *
 * 多層防御。isolated world という閉じ方とは独立に、main 側でも必ず関門を通す。
 *
 *   1. 設定中のフォルダ配下であること。`path.resolve` の前方一致だけでは
 *      `C:\sounds-secret` が `C:\sounds` の配下と誤判定されるので、区切り文字まで含めて見る
 *   2. **realpath で比較する**。シンボリックリンクやジャンクションを置かれると、
 *      文字列としては配下でも実体は任意の場所を指しうる
 *   3. 音声の拡張子であること。フォルダ配下でも config.json や任意のファイルは渡さない
 *   4. 実在するファイルであること（ディレクトリは渡さない）
 */
export function resolveSoundPath(fs: SoundsFs, folder: string, requested: string): ResolveResult {
  if (folder === '') return { ok: false, error: '音源フォルダが設定されていません' }
  if (typeof requested !== 'string' || requested === '') {
    return { ok: false, error: 'パスが指定されていません' }
  }
  // NUL 混入は path 系 API が投げる前にここで断つ
  if (requested.includes('\0')) return { ok: false, error: 'パスに使えない文字が含まれています' }

  const abs = path.resolve(folder, requested)
  if (!isAudio(abs)) return { ok: false, error: '音声ファイルではありません' }

  let realFolder: string
  let realTarget: string
  try {
    realFolder = fs.realpathSync(folder)
    realTarget = fs.realpathSync(abs)
  } catch {
    return { ok: false, error: 'ファイルが見つかりません' }
  }

  if (!isInside(realFolder, realTarget)) {
    return { ok: false, error: '音源フォルダの外は読み取れません' }
  }

  try {
    if (!fs.statSync(realTarget).isFile()) return { ok: false, error: 'ファイルではありません' }
  } catch {
    return { ok: false, error: 'ファイルが見つかりません' }
  }

  return { ok: true, path: realTarget }
}

/**
 * child が parent の配下かどうか。
 *
 * 区切り文字まで含めて比べる。前方一致だけだと `C:\sounds` に対して
 * `C:\sounds-secret\x.wav` が通ってしまう。Windows は大文字小文字を
 * 区別しないので畳んでから比べる。
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  if (rel === '') return false
  if (path.isAbsolute(rel)) return false
  // '..' で始まるなら外へ出ている
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}
