/**
 * 注入する fs の型。
 *
 * Electron の中では original-fs を渡す。素の fs は .asar を通るパスを
 * アーカイブとして横取りするので、app.asar の差し替えには使えない。
 *
 * readFileSync は Buffer と string の両方を返しうるため、呼び出し
 * シグネチャを 1 箇所に定義して共有する。別々に宣言すると、両方を
 * extends した型で「同名プロパティが同一でない」と弾かれる。
 */
export interface ReadFileSync {
  (p: string): Buffer
  (p: string, enc: 'utf8'): string
}

export interface WriteFileSync {
  (p: string, data: Buffer): void
  (p: string, data: string, enc: 'utf8'): void
}

export interface FsRead {
  existsSync(p: string): boolean
  readFileSync: ReadFileSync
}
