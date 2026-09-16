import { GRAFT_ATTR } from './anchor.js'

/**
 * 音声パネルのビデオ(カメラ)ボタンを隠す。
 *
 * Discord の要素には属性もスタイルも足さない(React が管理する要素を書き換えると、
 * 純正のハンドラや再描画と食い違う)。代わりに html に印を付け、CSS だけで隠す。
 *
 * 隠すのは「自前ボタンが直下にいる列」の先頭の子だけ。純正の並びはカメラ → 画面 →
 * アクティビティ → サウンドボードで、先頭がカメラ。自前ボタンが無い列(VC 外の別画面など)や、
 * 先頭の直後が自前ボタン(= 先頭がサウンドボード自身)の列には効かない。
 */
export const CAMERA_HIDDEN_ATTR = 'data-voicecord-hide-camera'

export const CAMERA_HIDE_CSS = `html[${CAMERA_HIDDEN_ATTR}] [class*="actionButtons_"]:has(> [${GRAFT_ATTR}="graft"]) > :first-child:not([${GRAFT_ATTR}]):not(:has(+ [${GRAFT_ATTR}])){display:none !important}`

export function setCameraButtonHidden(doc: Document, hidden: boolean): void {
  if (hidden) doc.documentElement.setAttribute(CAMERA_HIDDEN_ATTR, '')
  else doc.documentElement.removeAttribute(CAMERA_HIDDEN_ATTR)
}
