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

export interface StateFs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string, enc: 'utf8'): void
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
