import path from 'node:path'

/**
 * patcher がどの Discord インストールから読まれたかを、自分の位置から割り出す。
 *
 * 副作用のある入口（index.ts）から分けてある。index.ts は electron を import し、
 * 読み込んだ時点で起動処理まで走るのでテストから触れない。
 */

/**
 * @param mainPath require.main.path。shim が entry なので
 *                 <...>/app-<version>/resources/app.asar（ファイル名ではなくディレクトリ）を指す。
 *                 Vencord は require.main.filename だけを書き換えるので path は影響を受けない。
 */
export function locateInstall(
  mainPath: string | undefined
): { resourcesDir: string; version: string } | null {
  if (!mainPath) return null
  const resourcesDir = path.dirname(mainPath)
  const appDir = path.dirname(resourcesDir)
  const name = path.basename(appDir)
  if (!name.startsWith('app-')) return null
  const version = name.slice(4)
  if (version.length === 0) return null
  return { resourcesDir, version }
}

/** app-<version> の 2 つ上のディレクトリ名からビルドを推定する */
export function guessBranch(resourcesDir: string): string {
  const branchDir = path.basename(path.dirname(path.dirname(resourcesDir))).toLowerCase()
  switch (branchDir) {
    case 'discord':
      return 'stable'
    case 'discordptb':
      return 'ptb'
    case 'discordcanary':
      return 'canary'
    case 'discorddevelopment':
      return 'development'
    default:
      return branchDir
  }
}
