import { createHash } from 'node:crypto'
import { buildFlatAsar } from './asarBuild.js'
import { classifyAppAsar, type AppAsarKind, type FsLike } from './asarInspect.js'
import { renderShimSource, SHIM_PACKAGE_JSON } from './shimSource.js'

/**
 * app.asar の差し替えは破壊的で、失敗すると Discord が起動しなくなる。
 * 手順は「常に app.asar が存在する状態を保つ」ことを最優先に組んである:
 *   1. 素の Discord なら copy（rename ではない）で _app.asar を作る
 *      → rename だと 2 と 3 の間で落ちたとき app.asar が消えて起動不能になる
 *   2. shim を <resources>/voicecord-shim.tmp に書く
 *      → パスに .asar を含めない。Electron の fs は .asar を通るパスを
 *         アーカイブとして横取りするため
 *   3. 同一ボリューム上の rename で app.asar へ原子的に差し替える
 *   4. 書いたものを読み直して検証し、駄目なら _app.asar から即ロールバックする
 */

/** Electron 側では original-fs を渡す。素の fs は .asar パスを横取りするため使えない。 */
export interface PatchFs extends FsLike {
  copyFileSync(src: string, dest: string): void
  renameSync(src: string, dest: string): void
  writeFileSync(p: string, data: Buffer): void
  unlinkSync(p: string): void
}

export interface PatchTarget {
  /** <...>/app-<version>/resources */
  resourcesDir: string
  appAsar: string
  backupAsar: string
  /** 一時ファイル。パスに .asar を含めないこと */
  tmpFile: string
}

/** resources ディレクトリから操作対象のパス一式を組み立てる */
export function targetFor(resourcesDir: string, join: (...p: string[]) => string): PatchTarget {
  return {
    resourcesDir,
    appAsar: join(resourcesDir, 'app.asar'),
    backupAsar: join(resourcesDir, '_app.asar'),
    tmpFile: join(resourcesDir, 'voicecord-shim.tmp')
  }
}

export interface PatchPlanOk {
  ok: true
  /** 書き込む連鎖。先頭は必ず VoiceCord の patcher */
  chain: string[]
  /** 既存の shim から引き継いだ他 mod の patcher */
  preserved: string[]
  /** _app.asar を新しく作る必要があるか */
  needsBackup: boolean
  current: AppAsarKind
}

export interface PatchPlanNg {
  ok: false
  reason: string
}

export type PatchPlan = PatchPlanOk | PatchPlanNg

export interface PlanOptions {
  /** VoiceCord の patcher.js の絶対パス */
  voicecordPatcher: string
  /**
   * 連鎖に足したい他 mod の patcher。既存 shim から引き継ぐぶんとは別に明示指定する。
   * 既に連鎖にあるものは重複しない。
   */
  extraChain?: readonly string[]
}

/**
 * 適用計画を立てる。ここで弾いた場合は一切ファイルを触らない。
 *
 * 既存の他 mod は「引き継ぐ」だけで、こちらから増やすことはしない。
 * ディスク上に Vencord があるからといって、Vencord が入っていない
 * インストールに勝手に注入するのは筋が悪いため。
 */
export function planPatch(fs: PatchFs, t: PatchTarget, opts: PlanOptions): PatchPlan {
  const current = classifyAppAsar(fs, t.appAsar)

  if (current.kind === 'missing') {
    return { ok: false, reason: `app.asar が見つかりません: ${t.appAsar}` }
  }
  if (current.kind === 'unknown') {
    return {
      ok: false,
      reason: `app.asar の中身が想定外です。手を触れずに中断しました（${current.reason}）`
    }
  }

  const backup = classifyAppAsar(fs, t.backupAsar)

  if (current.kind === 'plain') {
    // 素の Discord。_app.asar があるなら、それが本体として妥当か確かめる
    if (backup.kind !== 'missing' && backup.kind !== 'plain') {
      return {
        ok: false,
        reason: `_app.asar が Discord 本体ではありません（${backup.kind}）。手動での確認が必要です`
      }
    }
    // 既に妥当な _app.asar があるならそれを温存する（既知の正本を上書きしない）
    const needsBackup = backup.kind === 'missing'
    return {
      ok: true,
      chain: composeChain(opts, []),
      preserved: [],
      needsBackup,
      current
    }
  }

  // ここから先は app.asar が shim。本体は _app.asar にあるはず
  if (backup.kind === 'missing') {
    return {
      ok: false,
      reason:
        'app.asar が別の mod の shim なのに _app.asar がありません。' +
        'Discord 本体の所在が不明なため中断しました。Discord の再インストールが必要です'
    }
  }
  if (backup.kind !== 'plain') {
    return {
      ok: false,
      reason: `_app.asar が Discord 本体ではありません（${backup.kind}）。手動での確認が必要です`
    }
  }

  const preserved =
    current.kind === 'shim'
      ? current.chain.filter((p) => !samePath(p, opts.voicecordPatcher))
      : current.requires.filter((p) => !samePath(p, opts.voicecordPatcher))

  return { ok: true, chain: composeChain(opts, preserved), preserved, needsBackup: false, current }
}

/** VoiceCord を先頭に、引き継ぎと明示追加を重複なく並べる */
function composeChain(opts: PlanOptions, preserved: readonly string[]): string[] {
  const chain = [opts.voicecordPatcher]
  for (const p of [...preserved, ...(opts.extraChain ?? [])]) {
    if (!chain.some((q) => samePath(q, p))) chain.push(p)
  }
  return chain
}

/** Windows のパスは大文字小文字を区別しない */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export interface PatchResult {
  chain: string[]
  /** 差し替え前の Discord 本体の SHA-256 */
  originalSha256: string
  backedUp: boolean
}

/**
 * 計画を実行する。呼び出し前に Discord が起動していないことを必ず確認すること
 * （このモジュールはプロセスを見ない）。
 */
export function applyPatch(fs: PatchFs, t: PatchTarget, plan: PatchPlanOk): PatchResult {
  // TOCTOU 対策: 計画を立てたときから状況が変わっていないか見直す
  const now = classifyAppAsar(fs, t.appAsar)
  if (now.kind !== plan.current.kind) {
    throw new Error(
      `app.asar の状態が計画時（${plan.current.kind}）から ${now.kind} に変わっています。やり直してください`
    )
  }

  if (plan.needsBackup) {
    // rename ではなく copy。ここで落ちても app.asar は残る
    fs.copyFileSync(t.appAsar, t.backupAsar)
  }
  const originalSha256 = sha256(fs.readFileSync(t.backupAsar))

  const shim = buildFlatAsar({
    'index.js': renderShimSource(plan.chain),
    'package.json': SHIM_PACKAGE_JSON
  })
  fs.writeFileSync(t.tmpFile, shim)
  fs.renameSync(t.tmpFile, t.appAsar)

  // 書いたものを読み直して検証する
  const written = classifyAppAsar(fs, t.appAsar)
  if (written.kind !== 'shim' || !sameChain(written.chain, plan.chain)) {
    rollback(fs, t)
    throw new Error(
      `shim の書き込み検証に失敗しました（${written.kind}）。_app.asar から復旧しました`
    )
  }

  return { chain: plan.chain, originalSha256, backedUp: plan.needsBackup }
}

export type UnpatchMode =
  /** VoiceCord だけ外し、他 mod の連鎖は残す */
  | 'voicecordOnly'
  /** 素の Discord に戻す。他 mod も全部外れる */
  | 'full'

export interface UnpatchResult {
  mode: UnpatchMode
  /** 残した他 mod の patcher */
  remaining: string[]
  /** _app.asar を消して素に戻したか */
  restored: boolean
}

export function unpatch(
  fs: PatchFs,
  t: PatchTarget,
  mode: UnpatchMode,
  voicecordPatcher: string
): UnpatchResult {
  const current = classifyAppAsar(fs, t.appAsar)
  if (current.kind === 'plain') return { mode, remaining: [], restored: false }
  if (current.kind === 'missing' || current.kind === 'unknown') {
    throw new Error(`app.asar を解除できません（${current.kind}）`)
  }

  const backup = classifyAppAsar(fs, t.backupAsar)
  if (backup.kind !== 'plain') {
    throw new Error(
      `_app.asar が Discord 本体ではありません（${backup.kind}）。手動での復旧が必要です`
    )
  }

  const remaining =
    current.kind === 'shim'
      ? current.chain.filter((p) => !samePath(p, voicecordPatcher))
      : current.requires.filter((p) => !samePath(p, voicecordPatcher))

  if (mode === 'full' || remaining.length === 0) {
    restoreOriginal(fs, t)
    return { mode, remaining: [], restored: true }
  }

  // 他 mod を残す。VoiceCord 形式の shim だが、連鎖の中身は他 mod だけになる
  const shim = buildFlatAsar({
    'index.js': renderShimSource(remaining),
    'package.json': SHIM_PACKAGE_JSON
  })
  fs.writeFileSync(t.tmpFile, shim)
  fs.renameSync(t.tmpFile, t.appAsar)
  return { mode, remaining, restored: false }
}

/** _app.asar を app.asar に戻し、_app.asar を消す */
function restoreOriginal(fs: PatchFs, t: PatchTarget): void {
  // copy → 検証 → 削除の順にする。rename 一発だと途中で落ちたとき両方消える
  fs.copyFileSync(t.backupAsar, t.tmpFile)
  fs.renameSync(t.tmpFile, t.appAsar)
  if (classifyAppAsar(fs, t.appAsar).kind !== 'plain') {
    throw new Error('復元後の app.asar が Discord 本体として読めません')
  }
  fs.unlinkSync(t.backupAsar)
}

function rollback(fs: PatchFs, t: PatchTarget): void {
  try {
    fs.copyFileSync(t.backupAsar, t.tmpFile)
    fs.renameSync(t.tmpFile, t.appAsar)
  } catch {
    // ここまで来たら自動復旧は諦める。呼び出し側が復旧手順を案内する
  }
}

function sameChain(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => samePath(x, b[i] ?? ''))
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
