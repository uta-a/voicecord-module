/**
 * preload の登録。
 *
 * BrowserWindow をラップしない。Discord のメインウィンドウは
 * sandbox:false / contextIsolation:true を自分で設定しており（Stable 1.0.9256 と
 * Canary 1.0.1099 の core.asar で確認済み）、Vencord が BrowserWindow をラップして
 * いる唯一の理由（sandbox を落とす）が我々には無い。
 *
 * registerPreloadScript ならセッションに直接足せるので、Vencord の BrowserWindow
 * サブクラスとも process.env.DISCORD_PRELOAD とも一切干渉しない。両者の preload は
 * チェーンせず並列に読み込まれる。
 */

export const PRELOAD_ID = 'voicecord'

/** electron の Session のうち、ここで使うものだけ */
export interface SessionLike {
  registerPreloadScript?: (script: { id?: string; type: 'frame' | 'service-worker'; filePath: string }) => string
  getPreloadScripts?: () => Array<{ id: string; filePath: string }>
  /** 旧 API。registerPreloadScript が無い環境向けのフォールバック */
  setPreloads?: (paths: string[]) => void
  getPreloads?: () => string[]
}

export type RegisterResult =
  | { ok: true; via: 'registerPreloadScript' | 'setPreloads' | 'already' }
  | { ok: false; error: string }

/**
 * セッションに preload を登録する。二重登録はしない。
 * 失敗しても throw しない（UI が出ないだけで Discord は通常どおり動く）。
 */
export function registerPreload(ses: SessionLike, filePath: string): RegisterResult {
  try {
    if (ses.getPreloadScripts) {
      const existing = ses.getPreloadScripts()
      if (existing.some((s) => s.id === PRELOAD_ID)) return { ok: true, via: 'already' }
    }
    if (ses.registerPreloadScript) {
      ses.registerPreloadScript({ id: PRELOAD_ID, type: 'frame', filePath })
      return { ok: true, via: 'registerPreloadScript' }
    }
    if (ses.setPreloads && ses.getPreloads) {
      const current = ses.getPreloads()
      if (current.includes(filePath)) return { ok: true, via: 'already' }
      ses.setPreloads([...current, filePath])
      return { ok: true, via: 'setPreloads' }
    }
    return { ok: false, error: 'このセッションには preload を登録する API がありません' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
