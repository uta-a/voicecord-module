/**
 * OS グローバルの緊急停止ホットキー（ゲート復帰 4 層の 4 層目）。
 *
 * マイクが開きっぱなしになった最悪のケースの脱出口。Discord にフォーカスが
 * 無くても、パネルが開けない状態（UI が壊れた・VC の外にいる）でも効く必要が
 * あるので、renderer ではなく main プロセスの globalShortcut に登録する。
 *
 * 登録は他のアプリに同じ組み合わせを取られていると失敗する。そのときは
 * 黙って諦めず、理由を返して UI に出す（効かない脱出口を効くと思わせない）。
 */

export const EMERGENCY_STOP_ACCELERATOR = 'Control+Alt+Shift+X'

/** electron の globalShortcut のうち、ここで使うものだけ */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type RegisterResult = { ok: true } | { ok: false; error: string }

export function registerEmergencyStop(
  gs: GlobalShortcutLike,
  onStop: () => void,
  accelerator: string = EMERGENCY_STOP_ACCELERATOR
): RegisterResult {
  let registered: boolean
  try {
    registered = gs.register(accelerator, () => {
      // ここで投げると Electron のログに埋もれて誰にも届かない
      try {
        onStop()
      } catch (e) {
        console.error('[VoiceCord] 緊急停止の処理に失敗しました', e)
      }
    })
  } catch (e) {
    return {
      ok: false,
      error: `緊急停止ホットキー ${accelerator} を登録できません: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (!registered) {
    return {
      ok: false,
      error: `緊急停止ホットキー ${accelerator} は他のアプリに使われているため登録できませんでした`
    }
  }
  return { ok: true }
}
