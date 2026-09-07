/**
 * shim 用の最小 asar ライタ。
 *
 * shim はトップレベルにファイル 2 個（index.js / package.json）しか持たないので、
 * @electron/asar を実行時に引き込まず自前で組み立てる。@electron/asar は素の fs で
 * 書き出すため、Electron の中から resources 配下を触らせたくないという事情もある。
 *
 * ヘッダは Chromium の Pickle 形式。実機の Vencord shim（219 バイト）から確認した:
 *   u32@0  = 4                       次のフィールドのサイズ
 *   u32@4  = 8 + alignedLen          本体開始位置は 8 + この値
 *   u32@8  = 4 + alignedLen
 *   u32@12 = len                     ヘッダ JSON の文字列長（パディング前）
 *   [16 .. 16+len)                   ヘッダ JSON
 *   [16+len .. 16+alignedLen)        0 パディング
 *   [16+alignedLen ..)               ファイル本体
 * ここで alignedLen は len を 4 バイト境界へ切り上げたもの。
 */

/** 4 バイト境界へ切り上げる */
function align4(n: number): number {
  return (n + 3) & ~3
}

/**
 * トップレベルにファイルだけを持つ asar を組み立てる。
 * キーの挿入順がそのままアーカイブ内の順序になる。
 */
export function buildFlatAsar(files: Record<string, string | Buffer>): Buffer {
  const entries: Array<{ name: string; body: Buffer; offset: number }> = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    entries.push({ name, body, offset })
    offset += body.length
  }

  const table: Record<string, { size: number; offset: string }> = {}
  for (const e of entries) table[e.name] = { size: e.body.length, offset: String(e.offset) }
  const headerString = JSON.stringify({ files: table })
  const len = Buffer.byteLength(headerString, 'utf8')
  const alignedLen = align4(len)

  const head = Buffer.alloc(16 + alignedLen) // 余りは 0 のままパディングになる
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + alignedLen, 4)
  head.writeUInt32LE(4 + alignedLen, 8)
  head.writeUInt32LE(len, 12)
  head.write(headerString, 16, 'utf8')

  return Buffer.concat([head, ...entries.map((e) => e.body)])
}
