import { classifyAppAsar, type AppAsarKind, type FsLike } from './asarInspect.js'

/**
 * Discord のインストールを走査してパッチ状態を出す。
 *
 * 判定は必ず app.asar の実物を読んで行い、state.json は補助情報にしか使わない。
 * state.json が古くても真実を誤らないようにするため。
 */

export type Branch = 'stable' | 'ptb' | 'canary' | 'development'

export interface BranchSpec {
  branch: Branch
  /** %LOCALAPPDATA% 直下のディレクトリ名 */
  dirName: string
  /** 実行ファイル名（起動中かどうかの判定に使う） */
  exeName: string
  label: string
}

export const BRANCHES: readonly BranchSpec[] = [
  { branch: 'stable', dirName: 'Discord', exeName: 'Discord.exe', label: 'Discord Stable' },
  { branch: 'ptb', dirName: 'DiscordPTB', exeName: 'DiscordPTB.exe', label: 'Discord PTB' },
  { branch: 'canary', dirName: 'DiscordCanary', exeName: 'DiscordCanary.exe', label: 'Discord Canary' },
  {
    branch: 'development',
    dirName: 'DiscordDevelopment',
    exeName: 'DiscordDevelopment.exe',
    label: 'Discord Development'
  }
]

export interface DiscordInstall {
  spec: BranchSpec
  /** 例: 1.0.9256 */
  version: string
  /** <...>/app-1.0.9256 */
  appDir: string
  resourcesDir: string
  status: AppAsarKind
  /** _app.asar があるか（＝何らかの mod が入っているか） */
  hasBackup: boolean
}

export interface ScanFs extends FsLike {
  readdirSync(p: string): string[]
}

/**
 * バージョン文字列を数値で比較する。
 * 辞書順だと app-1.0.999 が app-1.0.1099 より新しいと判定されてしまう。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const na = Number(pa[i] ?? 0)
    const nb = Number(pb[i] ?? 0)
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      // 数値でない部分が混ざったら、そこだけ文字列比較に落とす
      const sa = pa[i] ?? ''
      const sb = pb[i] ?? ''
      if (sa !== sb) return sa < sb ? -1 : 1
      continue
    }
    if (na !== nb) return na - nb
  }
  return 0
}

/** app-<version> ディレクトリ名からバージョンを取り出す。形式が違えば null。 */
export function parseAppDirName(name: string): string | null {
  if (!name.startsWith('app-')) return null
  const v = name.slice(4)
  return v.length > 0 ? v : null
}

/** 指定ブランチの最新 app-<version> を返す。無ければ null。 */
export function newestAppDir(fs: ScanFs, branchDir: string): { version: string; name: string } | null {
  if (!fs.existsSync(branchDir)) return null
  let best: { version: string; name: string } | null = null
  for (const name of fs.readdirSync(branchDir)) {
    const version = parseAppDirName(name)
    if (version === null) continue
    if (best === null || compareVersions(version, best.version) > 0) best = { version, name }
  }
  return best
}

export interface ScanOptions {
  /** %LOCALAPPDATA% */
  localAppData: string
  join: (...p: string[]) => string
}

/** 全ブランチを走査する。インストールされていないブランチは結果に出ない。 */
export function scanInstalls(fs: ScanFs, opts: ScanOptions): DiscordInstall[] {
  const out: DiscordInstall[] = []
  for (const spec of BRANCHES) {
    const branchDir = opts.join(opts.localAppData, spec.dirName)
    const newest = newestAppDir(fs, branchDir)
    if (newest === null) continue
    const appDir = opts.join(branchDir, newest.name)
    const resourcesDir = opts.join(appDir, 'resources')
    if (!fs.existsSync(resourcesDir)) continue
    out.push({
      spec,
      version: newest.version,
      appDir,
      resourcesDir,
      status: classifyAppAsar(fs, opts.join(resourcesDir, 'app.asar')),
      hasBackup: fs.existsSync(opts.join(resourcesDir, '_app.asar'))
    })
  }
  return out
}

export type InstallState =
  /** 未パッチ */
  | { state: 'clean' }
  /** VoiceCord が入っている */
  | { state: 'voicecord'; chain: string[] }
  /** 他の mod だけが入っている */
  | { state: 'otherMod'; requires: string[] }
  /** 手を出すべきでない */
  | { state: 'broken'; reason: string }

/** 走査結果を UI に出す 1 行ぶんの状態へ落とす */
export function installState(install: DiscordInstall): InstallState {
  const s = install.status
  switch (s.kind) {
    case 'plain':
      return install.hasBackup
        ? {
            state: 'broken',
            reason: 'app.asar は素の Discord ですが _app.asar が残っています。手動での確認が必要です'
          }
        : { state: 'clean' }
    case 'shim':
      return install.hasBackup
        ? { state: 'voicecord', chain: s.chain }
        : { state: 'broken', reason: 'shim なのに _app.asar がありません（Discord 本体の所在が不明）' }
    case 'foreignShim':
      return install.hasBackup
        ? { state: 'otherMod', requires: s.requires }
        : { state: 'broken', reason: 'shim なのに _app.asar がありません（Discord 本体の所在が不明）' }
    case 'missing':
      return { state: 'broken', reason: 'app.asar がありません' }
    case 'unknown':
      return { state: 'broken', reason: s.reason }
  }
}

/**
 * VoiceCord が「動いているはず」の状態かどうか。
 * パッチが外れているとサウンドが無言で鳴らなくなるので、マネージャはこれを先頭に出す。
 */
export function isVoiceCordActive(install: DiscordInstall, voicecordPatcher: string): boolean {
  const st = installState(install)
  if (st.state !== 'voicecord') return false
  return st.chain.some((p) => p.toLowerCase() === voicecordPatcher.toLowerCase())
}
