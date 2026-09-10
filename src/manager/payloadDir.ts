/**
 * ビルド成果物（payload/）の在り処。
 *
 * 開発時に app.getAppPath() を使ってはいけない。マネージャの出力先
 * dist-manager/ には CommonJS 宣言のための package.json を置いてあり、
 * Electron はそれを見つけてアプリのルートだと解釈する。結果
 * app.getAppPath() が <repo>/dist-manager を返し、payload を
 * dist-manager/payload に探しに行って「ビルド成果物がありません」で
 * 適用に失敗する（実機で踏んだ）。
 *
 * main.js の位置は dist-manager/main.js で固定なので、その 1 つ上を見る。
 */

export interface PayloadDirEnv {
  /** electron-builder で固めたか */
  isPackaged: boolean
  /** 配布時の resources ディレクトリ（process.resourcesPath） */
  resourcesPath: string
  /** main.js が置かれているディレクトリ（__dirname） */
  mainDir: string
}

export function resolvePayloadDir(
  env: PayloadDirEnv,
  join: (...p: string[]) => string
): string {
  // 配布時は extraResources で resources/payload へ入る
  if (env.isPackaged) return join(env.resourcesPath, 'payload')
  // 開発時は dist-manager/main.js の 1 つ上、つまりリポジトリ直下
  return join(env.mainDir, '..', 'payload')
}
