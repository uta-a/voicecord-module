/**
 * パッチ状態の記録（state.json）。
 *
 * これは補助情報でしかない。パッチが当たっているかどうかの判定は必ず app.asar の
 * 実物を読んで行う（scan.ts）。state.json が古くても真実を誤らないようにするため。
 *
 * ここが持つのは「実物からは分からないこと」だけ:
 *   - パッチを当てたときの Discord のバージョン
 *     → 実際の最新 app-* と食い違ったら「Discord が更新されたので再適用が必要」を出せる
 *   - 差し替え前の Discord 本体の SHA-256
 *   - patcher が最後に動いた日時
 *     → 一度も動いていない = パッチが外れている、が時系列で読める（可視化 4）
 */

export const STATE_VERSION = 1

export interface InstallRecord {
  /** stable / canary / ptb / development */
  branch: string
  /** パッチを当てたときの Discord のバージョン */
  discordVersion: string
  resourcesDir: string
  /** ISO 8601 */
  patchedAt: string
  /** 差し替え前の Discord 本体（_app.asar）の SHA-256 */
  originalSha256: string
  chain: string[]
  /** patcher が Discord の中で最後に動いた日時 */
  lastPatcherRunAt?: string
  /** そのとき patcher が見た Discord のバージョン */
  lastPatcherVersion?: string
}

export interface PatchState {
  version: number
  /** キーは resourcesDir を小文字化したもの（Windows は大文字小文字を区別しない） */
  installs: Record<string, InstallRecord>
}

export function emptyState(): PatchState {
  return { version: STATE_VERSION, installs: {} }
}

export function installKey(resourcesDir: string): string {
  return resourcesDir.toLowerCase()
}

/**
 * state.json の本文を解釈する。壊れていても throw せず空の状態を返す。
 * 設定ファイルを手で覗いただけで全部消える、という類の事故を避けるため、
 * 判断できない値は捨てるのではなく既定値へ矯正する。
 */
export function parseStateText(text: string): { state: PatchState; broken: boolean } {
  const stripped = text.replace(/^﻿/, '').trim()
  if (stripped.length === 0) return { state: emptyState(), broken: false }

  let raw: unknown
  try {
    raw = JSON.parse(stripped)
  } catch {
    return { state: emptyState(), broken: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { state: emptyState(), broken: true }
  }

  const obj = raw as Record<string, unknown>
  const installsRaw = obj['installs']
  const installs: Record<string, InstallRecord> = {}
  if (typeof installsRaw === 'object' && installsRaw !== null && !Array.isArray(installsRaw)) {
    for (const [key, value] of Object.entries(installsRaw as Record<string, unknown>)) {
      const rec = sanitizeRecord(value)
      if (rec) installs[key.toLowerCase()] = rec
    }
  }
  const version = typeof obj['version'] === 'number' ? obj['version'] : STATE_VERSION
  return { state: { version, installs }, broken: false }
}

function sanitizeRecord(value: unknown): InstallRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const str = (k: string): string => (typeof v[k] === 'string' ? (v[k] as string) : '')
  const resourcesDir = str('resourcesDir')
  // 場所が分からない記録は持っていても意味がない
  if (resourcesDir === '') return null
  const chain = Array.isArray(v['chain'])
    ? (v['chain'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const rec: InstallRecord = {
    branch: str('branch'),
    discordVersion: str('discordVersion'),
    resourcesDir,
    patchedAt: str('patchedAt'),
    originalSha256: str('originalSha256'),
    chain
  }
  if (typeof v['lastPatcherRunAt'] === 'string') rec.lastPatcherRunAt = v['lastPatcherRunAt']
  if (typeof v['lastPatcherVersion'] === 'string') rec.lastPatcherVersion = v['lastPatcherVersion']
  return rec
}

export function serializeState(state: PatchState): string {
  return JSON.stringify(state, null, 2) + '\n'
}

/**
 * パッチを当てたときの Discord のバージョンと、実際に入っているバージョンが
 * 食い違っているか。食い違っていれば再適用が要る。
 */
export function needsReapply(record: InstallRecord | undefined, currentVersion: string): boolean {
  if (!record) return false
  if (record.discordVersion === '') return false
  return record.discordVersion !== currentVersion
}

/**
 * ブランチに対する記録を探す。
 *
 * resourcesDir で引いてはいけない。Discord が更新されると app-<version> ごと
 * 入れ替わって resourcesDir が変わり、旧ディレクトリは削除される。そこで
 * resourcesDir 一致だけを見ると「記録なし ＝ 未パッチ ＝ 何も警告しない」に
 * なってしまい、VoiceCord が外れたことに気付けない。実際に Canary の
 * 1.0.1099 → 1.0.1158 の更新でこれが起きた。
 *
 * 同じブランチに複数の記録があれば、いちばん新しく適用したものを返す。
 */
export function findRecordForBranch(
  state: PatchState,
  branch: string
): InstallRecord | undefined {
  let best: InstallRecord | undefined
  for (const rec of Object.values(state.installs)) {
    if (rec.branch !== branch) continue
    if (!best || rec.patchedAt > best.patchedAt) best = rec
  }
  return best
}

export type BranchStatus =
  /** このブランチに適用した記録が無い */
  | { kind: 'never' }
  /** 記録どおりのバージョンに当たっている */
  | { kind: 'current' }
  /** 適用済みだったが Discord が更新されて外れた。再適用が要る */
  | { kind: 'staleAfterUpdate'; patchedVersion: string }

/**
 * 「以前このブランチに適用したのに、Discord が更新されて外れていないか」を判定する。
 * パッチが外れるとサウンドが無言で鳴らなくなるので、ここを取りこぼさない。
 */
export function branchStatus(
  state: PatchState,
  branch: string,
  currentVersion: string
): BranchStatus {
  const rec = findRecordForBranch(state, branch)
  if (!rec || rec.discordVersion === '') return { kind: 'never' }
  if (rec.discordVersion === currentVersion) return { kind: 'current' }
  return { kind: 'staleAfterUpdate', patchedVersion: rec.discordVersion }
}
