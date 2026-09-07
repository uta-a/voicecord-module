import type { FsRead, WriteFileSync } from './fsLike.js'
import {
  emptyState,
  installKey,
  parseStateText,
  serializeState,
  STATE_VERSION,
  type InstallRecord,
  type PatchState
} from './state.js'

/**
 * state.json の入出力。
 *
 * 書き込みは tmp → rename の原子的置換。旧アプリで「設定ファイルを手で覗いた
 * だけで全設定が消える」事故があったので、壊れた内容は捨てずに .broken へ
 * 退避してから空の状態で続行する。
 */

export interface StateFs extends FsRead {
  writeFileSync: WriteFileSync
  renameSync(src: string, dest: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
}

export function readState(fs: StateFs, statePath: string): PatchState {
  if (!fs.existsSync(statePath)) return emptyState()
  let text: string
  try {
    text = fs.readFileSync(statePath, 'utf8')
  } catch {
    return emptyState()
  }
  const { state, broken } = parseStateText(text)
  if (broken) {
    // 中身を失わせない。原因を後から追えるようにしておく
    try {
      fs.writeFileSync(statePath + '.broken', text, 'utf8')
    } catch {
      // 退避に失敗しても続行する
    }
  }
  return state
}

export function writeState(
  fs: StateFs,
  statePath: string,
  state: PatchState,
  dirOf: (p: string) => string
): void {
  fs.mkdirSync(dirOf(statePath), { recursive: true })
  const tmp = statePath + '.tmp'
  fs.writeFileSync(tmp, serializeState(state), 'utf8')
  fs.renameSync(tmp, statePath)
}

/** 1 インストールぶんの記録を差し替える（他のインストールの記録は残す） */
export function upsertInstall(state: PatchState, record: InstallRecord): PatchState {
  return {
    version: STATE_VERSION,
    installs: { ...state.installs, [installKey(record.resourcesDir)]: record }
  }
}

/**
 * 同じブランチの記録をすべて落とす。
 *
 * Discord は更新のたびに app-<version> ごと入れ替え、旧フォルダを消す。
 * つまり 1 ブランチに有効なインストールは 1 つだけ。古い記録を残すと
 * 「更新されて外れている」の判定でどちらを見るかが曖昧になり、再適用しても
 * 警告が消えなくなる。適用時に必ず掃除する。
 */
export function removeBranchRecords(state: PatchState, branch: string): PatchState {
  const installs: Record<string, InstallRecord> = {}
  for (const [key, rec] of Object.entries(state.installs)) {
    if (rec.branch !== branch) installs[key] = rec
  }
  return { version: STATE_VERSION, installs }
}

export function removeInstall(state: PatchState, resourcesDir: string): PatchState {
  const installs = { ...state.installs }
  delete installs[installKey(resourcesDir)]
  return { version: STATE_VERSION, installs }
}

export function getInstall(state: PatchState, resourcesDir: string): InstallRecord | undefined {
  return state.installs[installKey(resourcesDir)]
}

/**
 * patcher が Discord の中で起動するたびに呼ぶ。
 * 「mod が最後に動いた日時」が分かると、一度も動いていない = パッチが外れている、
 * が時系列で読める（可視化 4）。記録が無い場合は何もしない。
 */
export function markPatcherRun(
  state: PatchState,
  resourcesDir: string,
  discordVersion: string,
  now: string
): PatchState {
  const existing = getInstall(state, resourcesDir)
  if (!existing) return state
  return upsertInstall(state, {
    ...existing,
    lastPatcherRunAt: now,
    lastPatcherVersion: discordVersion
  })
}
