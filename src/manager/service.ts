import { applyPatch, planPatch, targetFor, unpatch, type PatchFs, type UnpatchMode } from './patch/apply.js'
import { isRunning, type ProcessLister } from './patch/running.js'
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
 * ここでは Discord を強制終了しない。起動中なら適用を断って理由を返す。
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
}

export function applyTo(deps: ServiceDeps, resourcesDir: string, opts: ApplyOptions = {}): OpResult {
  const install = findInstall(deps, resourcesDir)
  if (!install) return { ok: false, message: `インストールが見つかりません: ${resourcesDir}` }

  const check = isRunning(deps.listProcesses, install.spec.exeName)
  if (check.running) {
    return {
      ok: false,
      message: `${install.spec.label} が起動しています。終了してから実行してください（PID ${check.pids.join(', ') || '不明'}）`
    }
  }

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

export function unpatchFrom(deps: ServiceDeps, resourcesDir: string, mode: UnpatchMode): OpResult {
  const install = findInstall(deps, resourcesDir)
  if (!install) return { ok: false, message: `インストールが見つかりません: ${resourcesDir}` }

  const check = isRunning(deps.listProcesses, install.spec.exeName)
  if (check.running) {
    return {
      ok: false,
      message: `${install.spec.label} が起動しています。終了してから実行してください`
    }
  }

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
