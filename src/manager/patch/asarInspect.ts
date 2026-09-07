import type { FsRead } from '../../shared/fsLike.js'
import { parseShimChain, SHIM_MARKER } from './shimSource.js'

const BACKSLASH = String.fromCharCode(92)

/**
 * asar の読み取りは自前で行う。@electron/asar は素の fs を使うため、
 * Electron の中から app.asar を読むと asar 展開に横取りされてしまう。
 * ここでは呼び出し側から fs を注入させ、Electron 側では original-fs を渡す。
 */
export interface FsLike extends FsRead {
  statSync(p: string): { size: number }
}

export interface AsarHeader {
  files: Record<string, { size?: number; offset?: string; files?: unknown }>
}

export interface AsarView {
  header: AsarHeader
  /** ファイル本体の開始位置 */
  dataOffset: number
  buffer: Buffer
}

/** asar のヘッダを読む。asar として読めなければ throw する。 */
export function readAsar(fs: FsLike, filePath: string): AsarView {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 16) throw new Error(`too small to be an asar: ${filePath}`)
  // asar のヘッダは Chromium の Pickle 形式。
  //   [0..4)  = 4（次のフィールドのサイズ）
  //   [4..8)  = ヘッダ pickle のペイロード長（4 バイト境界にパディング済み）
  //   [12..16)= ヘッダ JSON の文字列長（パディングを含まない）
  // 本体の開始位置はパディング込みの 8 + [4..8) であって、16 + 文字列長ではない。
  // ここを取り違えると、ヘッダ長が 4 の倍数でない asar でだけ読み出しがずれる。
  const headerPickleSize = buffer.readUInt32LE(4)
  const headerSize = buffer.readUInt32LE(12)
  const dataOffset = 8 + headerPickleSize
  if (headerSize <= 0 || 16 + headerSize > buffer.length || dataOffset > buffer.length) {
    throw new Error(`invalid asar header size (${headerSize}/${headerPickleSize}): ${filePath}`)
  }
  let header: AsarHeader
  try {
    header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8')) as AsarHeader
  } catch (e) {
    throw new Error(`invalid asar header json: ${filePath} (${String(e)})`)
  }
  if (!header || typeof header !== 'object' || typeof header.files !== 'object') {
    throw new Error(`asar header has no files table: ${filePath}`)
  }
  return { header, dataOffset, buffer }
}

/** トップレベルのエントリ名一覧 */
export function topLevelNames(view: AsarView): string[] {
  return Object.keys(view.header.files)
}

/** トップレベルのファイルを文字列として読む。無ければ null。 */
export function readTopLevelFile(view: AsarView, name: string): string | null {
  const entry = view.header.files[name]
  if (!entry || entry.files || entry.size === undefined) return null
  const offset = Number(entry.offset ?? 0)
  const start = view.dataOffset + offset
  return view.buffer.subarray(start, start + entry.size).toString('utf8')
}

export type AppAsarKind =
  /** ファイルが無い */
  | { kind: 'missing' }
  /** 素の Discord（bundle.js を含む） */
  | { kind: 'plain'; size: number }
  /** VoiceCord が書いた連鎖 shim */
  | { kind: 'shim'; size: number; chain: string[] }
  /** 他の mod が書いた shim（Vencord など）。require しているパスを拾う */
  | { kind: 'foreignShim'; size: number; requires: string[] }
  /** asar として読めない、または想定外の中身 */
  | { kind: 'unknown'; size: number; reason: string }

/**
 * app.asar の形態を判定する。破壊的操作の前段チェックに使う。
 * どんな入力でも throw せず、判断できないものは unknown に落とす。
 */
export function classifyAppAsar(fs: FsLike, filePath: string): AppAsarKind {
  if (!fs.existsSync(filePath)) return { kind: 'missing' }
  const size = fs.statSync(filePath).size
  let view: AsarView
  try {
    view = readAsar(fs, filePath)
  } catch (e) {
    return { kind: 'unknown', size, reason: e instanceof Error ? e.message : String(e) }
  }
  const names = topLevelNames(view)
  if (names.includes('bundle.js')) return { kind: 'plain', size }

  const index = readTopLevelFile(view, 'index.js')
  if (index !== null && names.includes('package.json')) {
    const chain = parseShimChain(index)
    if (chain) return { kind: 'shim', size, chain }
    return { kind: 'foreignShim', size, requires: extractRequirePaths(index) }
  }
  return {
    kind: 'unknown',
    size,
    reason: `top-level entries were [${names.join(', ')}]; expected bundle.js, or index.js + package.json`
  }
}

/**
 * 他 mod の shim から require されている絶対パスを拾う。
 * shim は機械生成なので、クォート内にクォートが現れる状況は考えない。
 * バックスラッシュのエスケープ解除は JSON.parse に任せる。
 */
export function extractRequirePaths(source: string): string[] {
  const out: string[] = []
  const re = /require\(\s*("[^"]*"|'[^']*')\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const lit = m[1]
    if (lit === undefined) continue
    let value: string
    if (lit.startsWith('"')) {
      try {
        value = JSON.parse(lit) as string
      } catch {
        continue
      }
    } else {
      value = lit.slice(1, -1)
    }
    // shim 自身の require("path") / require("fs") のような組み込みは除外する
    if (!value.includes(BACKSLASH) && !value.includes('/')) continue
    out.push(value)
  }
  return out
}

export { SHIM_MARKER }
