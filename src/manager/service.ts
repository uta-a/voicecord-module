import { applyPatch, planPatch, targetFor, unpatch, type PatchFs, type UnpatchMode } from './patch/apply.js'
import { isRunning, type ProcessLister, type RunningCheck } from './patch/running.js'
import {
  installState,
  isVoiceCordActive,
  scanInstalls,
  type DiscordInstall,
  type ScanFs
} from './patch/scan.js'
import type { VoiceCordPaths } from '../shared/paths.js'
import { branchStatus } from '../shared/state.js'
import {
  getInstall,
  readState,
  removeBranchRecords,
  upsertInstall,
  writeState,
  type StateFs
} from '../shared/stateStore.js'

/**
 * マネージャの操作をひとまとめにした層。Electron に依存しないのでテストできる。
 *
 * 既定では Discord を終了させない。起動中なら適用を断って理由を返す。
 * ユーザーが明示的に選んだ（forceClose）ときだけ強制終了し、終わったら再起動する。
 */

export interface ServiceFs extends PatchFs, ScanFs, StateFs {
  readdirSync(p: string): string[]
  statSync(p: string): { size: number; isDirectory?: () => boolean }
  copyFileSync(src: string, dest: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
}

export interface ServiceDeps {
  fs: ServiceFs
  paths: VoiceCordPaths
  /** ビルド成果物の置き場（開発中は <repo>/payload、配布時は resources/payload） */
  payloadDir: string
  localAppData: string
  join: (...p: string[]) => string
  dirname: (p: string) => string
  listProcesses: ProcessLister
  /** そのイメージ名のプロセスを強制終了する。プロセスが無いなどで失敗したら例外を投げてよい */
  killProcess: (imageName: string) => void
  /** 終了待ちの間隔を空ける（テストでは即時にする） */
  sleep: (ms: number) => void
  /** <rootDir>\Update.exe --processStart <exeName> で Discord を起動する */
  startDiscord: (rootDir: string, exeName: string) => void
  now: () => string
}

export interface InstallRow {
  branch: string
  label: string
  version: string
  resourcesDir: string
  /** clean / voicecord / otherMod / broken */
  state: string
  detail: string
  /** VoiceCord が連鎖に入っているか */
  active: boolean
  /**
   * 以前このブランチに適用したのに Discord が更新されて外れている。
   * 放っておくとサウンドが無言で鳴らなくなるので、UI では前に出す。
   */
  staleVersion: boolean
  /** 外れている場合、どのバージョンに当てていたか */
  patchedVersion: string | null
  running: boolean
  /** patcher が Discord の中で最後に動いた日時 */
  lastPatcherRunAt: string | null
}

export function listInstalls(deps: ServiceDeps): InstallRow[] {
  const state = readState(deps.fs, deps.paths.state)
  return scanInstalls(deps.fs, { localAppData: deps.localAppData, join: deps.join }).map((i) =>
    toRow(deps, i, state)
  )
}

function toRow(
  deps: ServiceDeps,
  i: DiscordInstall,
  state: ReturnType<typeof readState>
): InstallRow {
  const record = getInstall(state, i.resourcesDir)
  // resourcesDir ではなくブランチで引く。Discord が更新されると
  // app-<version> ごと入れ替わって resourcesDir が変わるため
  const stale = branchStatus(state, i.spec.branch, i.version)
  const active = isVoiceCordActive(i, deps.paths.patcher)
  const detected = installState(i)
  // VoiceCord が生成した shim でも、VoiceCord だけ外した後は他 mod のみ。
  const st =
    detected.state === 'voicecord' && !active
      ? { state: 'otherMod' as const, requires: detected.chain }
      : detected
  const detail =
    st.state === 'voicecord'
      ? st.chain.join(' → ')
      : st.state === 'otherMod'
        ? st.requires.join(', ')
        : st.state === 'broken'
          ? st.reason
          : ''
  return {
    branch: i.spec.branch,
    label: i.spec.label,
    version: i.version,
    resourcesDir: i.resourcesDir,
    state: st.state,
    detail,
    active,
    staleVersion: !active && stale.kind === 'staleAfterUpdate',
    patchedVersion: !active && stale.kind === 'staleAfterUpdate' ? stale.patchedVersion : null,
    running: isRunning(deps.listProcesses, i.spec.exeName).running,
    lastPatcherRunAt: record?.lastPatcherRunAt ?? null
  }
}

export type OpResult = { ok: true; message: string } | { ok: false; message: string }

export interface ApplyOptions {
  /** 連鎖に足したい他 mod の patcher（Canary での連鎖テスト用） */
  extraChain?: readonly string[]
  /** 起動中なら強制終了してから行い、終わったら再起動する（ユーザーが明示的に選んだときだけ） */
  forceClose?: boolean
}

export interface UnpatchOptions {
  /** 起動中なら強制終了してから行い、終わったら再起動する（ユーザーが明示的に選んだときだけ） */
  forceClose?: boolean
}

export function applyTo(deps: ServiceDeps, resourcesDir: string, opts: ApplyOptions = {}): OpResult {
  const install = findInstall(deps, resourcesDir)
  if (!install) return { ok: false, message: `インストールが見つかりません: ${resourcesDir}` }

  return withDiscordClosed(
    deps,
    install,
    opts.forceClose === true,
    (check) =>
      `${install.spec.label} が起動しています。終了してから実行してください（PID ${check.pids.join(', ') || '不明'}）`,
    () => applyToInstall(deps, install, resourcesDir, opts)
  )
}

function applyToInstall(
  deps: ServiceDeps,
  install: DiscordInstall,
  resourcesDir: string,
  opts: ApplyOptions
): OpResult {
  const t = targetFor(resourcesDir, deps.join)
  const plan = planPatch(deps.fs, t, { voicecordPatcher: deps.paths.patcher, extraChain: opts.extraChain })
  if (!plan.ok) return { ok: false, message: plan.reason }

  // shim が指す先を先に用意する。順序が逆だと、パッチは当たったのに
  // patcher が無い状態で Discord が起動してしまう
  try {
    deployPayload(deps)
  } catch (e) {
    return { ok: false, message: `ペイロードの配置に失敗しました: ${msg(e)}` }
  }

  let result
  try {
    result = applyPatch(deps.fs, t, plan)
  } catch (e) {
    return { ok: false, message: msg(e) }
  }

  const state = readState(deps.fs, deps.paths.state)
  writeState(
    deps.fs,
    deps.paths.state,
    // 同じブランチの古い記録は掃除する。残すと再適用しても
    // 「更新されて外れている」の警告が消えない
    upsertInstall(removeBranchRecords(state, install.spec.branch), {
      branch: install.spec.branch,
      discordVersion: install.version,
      resourcesDir,
      patchedAt: deps.now(),
      originalSha256: result.originalSha256,
      chain: result.chain
    }),
    deps.dirname
  )

  const preserved = plan.preserved.length > 0 ? `（${plan.preserved.length} 件の他 mod を引き継ぎ）` : ''
  return {
    ok: true,
    message:
      `${install.spec.label} ${install.version} に適用しました${preserved}\n` +
      // frida_binding.node は AV に検知されうる。隔離されると Discord は動くのに
      // 音だけ鳴らなくなるので、適用の直後に除外先を伝える（固定パスなので一度で済む）
      `Windows Defender などのウイルス対策ソフトがエンジンを隔離することがあります。` +
      `その場合は除外に次のフォルダを追加してください: ${deps.paths.root}`
  }
}

export function unpatchFrom(
  deps: ServiceDeps,
  resourcesDir: string,
  mode: UnpatchMode,
  opts: UnpatchOptions = {}
): OpResult {
  const install = findInstall(deps, resourcesDir)
  if (!install) return { ok: false, message: `インストールが見つかりません: ${resourcesDir}` }

  return withDiscordClosed(
    deps,
    install,
    opts.forceClose === true,
    () => `${install.spec.label} が起動しています。終了してから実行してください`,
    () => unpatchFromInstall(deps, install, resourcesDir, mode)
  )
}

function unpatchFromInstall(
  deps: ServiceDeps,
  install: DiscordInstall,
  resourcesDir: string,
  mode: UnpatchMode
): OpResult {
  const t = targetFor(resourcesDir, deps.join)
  let result
  try {
    result = unpatch(deps.fs, t, mode, deps.paths.patcher)
  } catch (e) {
    return { ok: false, message: msg(e) }
  }

  const state = readState(deps.fs, deps.paths.state)
  // 意図的に外した後、古い版の記録から「更新で外れた」と誤警告しない。
  writeState(deps.fs, deps.paths.state, removeBranchRecords(state, install.spec.branch), deps.dirname)

  if (result.restored) return { ok: true, message: `${install.spec.label} を素の状態に戻しました` }
  return {
    ok: true,
    message: `${install.spec.label} から VoiceCord を外しました（${result.remaining.length} 件の他 mod は残しています）`
  }
}

/** 強制終了後、終了を確かめる間隔と上限 */
const EXIT_POLL_MS = 250
const EXIT_TIMEOUT_MS = 10_000

/**
 * Discord が起動していない状態で op を行う。
 *
 * 起動中なら、forceClose でなければ断る。forceClose なら強制終了して終了を確かめてから行い、
 * op の成否にかかわらず最後に再起動する（落としたまま放置しない）。
 */
function withDiscordClosed(
  deps: ServiceDeps,
  install: DiscordInstall,
  forceClose: boolean,
  refuse: (check: RunningCheck) => string,
  op: () => OpResult
): OpResult {
  const { exeName, label } = install.spec
  const check = isRunning(deps.listProcesses, exeName)
  if (!check.running) return op()
  if (!forceClose) return { ok: false, message: refuse(check) }
  // tasklist が失敗して判定できないだけのときは、落とすべきプロセスがあるか分からないので進まない
  if (check.pids.length === 0) {
    return { ok: false, message: `${label} の起動状態を確認できません。手動で終了してからもう一度実行してください` }
  }

  try {
    deps.killProcess(exeName)
  } catch {
    // 確認の間に自分で終了していても taskkill は失敗する。終わったかどうかは下で確かめる
  }
  // 終了を確かめられないまま差し替えに進むと、ロックされた app.asar を中途半端に触りうる
  if (!waitForExit(deps, exeName)) {
    return {
      ok: false,
      message: `${label} を終了できませんでした。タスクマネージャーで ${exeName} を終了してから、もう一度実行してください`
    }
  }

  // op が例外を投げても（状態ファイルの書き込み失敗など）、落としたまま放置しない
  let result: OpResult
  try {
    result = op()
  } catch (e) {
    result = { ok: false, message: msg(e) }
  }
  return { ...result, message: `${result.message}\n${restartDiscord(deps, install)}` }
}

/** 終了したら true。判定できない（isRunning が running:true を返す）ままなら false */
function waitForExit(deps: ServiceDeps, exeName: string): boolean {
  for (let waited = 0; ; waited += EXIT_POLL_MS) {
    if (!isRunning(deps.listProcesses, exeName).running) return true
    if (waited >= EXIT_TIMEOUT_MS) return false
    deps.sleep(EXIT_POLL_MS)
  }
}

/** 再起動の結果をメッセージの 1 行で返す */
function restartDiscord(deps: ServiceDeps, install: DiscordInstall): string {
  // Update.exe は app-<version> の親（%LOCALAPPDATA%\<dirName>）にある。
  // app-<version> 内の exe を直接起動すると、更新や古い版の掃除が働かない
  const rootDir = deps.dirname(install.appDir)
  const manual = `${install.spec.label} を手動で起動してください`
  if (!deps.fs.existsSync(deps.join(rootDir, 'Update.exe'))) {
    return `Update.exe が見つからないため再起動できませんでした。${manual}`
  }
  try {
    deps.startDiscord(rootDir, install.spec.exeName)
  } catch (e) {
    return `${install.spec.label} を再起動できませんでした（${msg(e)}）。${manual}`
  }
  // spawn の失敗は後から非同期に届くので、ここで分かるのは起動を始めたところまで
  return `${install.spec.label} の再起動を開始しました`
}

function findInstall(deps: ServiceDeps, resourcesDir: string): DiscordInstall | undefined {
  return scanInstalls(deps.fs, { localAppData: deps.localAppData, join: deps.join }).find(
    (i) => i.resourcesDir.toLowerCase() === resourcesDir.toLowerCase()
  )
}

/** payload/ の中身を %LOCALAPPDATA%\VoiceCord\dist\ へ配る */
export function deployPayload(deps: ServiceDeps): void {
  copyDir(deps.fs, deps.payloadDir, deps.paths.dist, deps.join)
}

function copyDir(
  fs: ServiceFs,
  src: string,
  dest: string,
  join: (...p: string[]) => string
): void {
  if (!fs.existsSync(src)) throw new Error(`ビルド成果物がありません: ${src}`)
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const from = join(src, name)
    const to = join(dest, name)
    const stat = fs.statSync(from)
    if (stat.isDirectory?.()) copyDir(fs, from, to, join)
    else if (!fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to))) {
      fs.copyFileSync(from, to)
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
