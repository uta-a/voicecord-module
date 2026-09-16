import { GRAFT_ATTR, type AnchorHit } from './anchor.js'
import { stripStateTokens } from './graft.js'

/**
 * 純正サウンドボードのヘッダー（検索欄の右の音量アイコン）の隣に、
 * VoiceCord で鳴らしている音をすべて止めるボタンを置く。
 *
 * 出し入れの監視は createGraft に任せ、ここは「どこに置くか」と「何を置くか」だけを持つ。
 * Discord の要素そのものには触れず、見た目は音量アイコンのクラスを実行時に写して合わせる。
 * 構造は Canary 1.0.1175 の実測（header__ の中に検索欄と settingsClickArea__ が並ぶ）。
 */

export const SOUNDBOARD_STOP_LABEL = 'VoiceCord の音をすべて停止'
/** GRAFT_ATTR の値。'graft' 以外にして、ビデオボタンを隠す CSS に拾われないようにする */
export const SOUNDBOARD_STOP_MARK = 'soundboard-stop'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 純正サウンドボードの音量アイコン。ポップアウトが開いていなければ null */
export function findSoundboardVolumeButton(doc: ParentNode, ignoreWithin?: Node | null): AnchorHit | null {
  for (const dialog of Array.from(doc.querySelectorAll('[role="dialog"]'))) {
    if (ignoreWithin?.contains(dialog)) continue
    if (dialog.querySelector('[class*="soundButton__"]') === null) continue
    const volume = dialog.querySelector<HTMLElement>(`[class*="settingsClickArea"]:not([${GRAFT_ATTR}])`)
    if (volume) return { anchor: volume, tier: 1 }
  }
  return null
}

/** 停止アイコン（角の丸い四角）。クラスは音量アイコンの svg から写して大きさと色を揃える */
function createStopIcon(doc: Document, like: Element | null): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  const cls = like?.getAttribute('class')
  if (cls) svg.setAttribute('class', cls)
  for (const a of ['width', 'height']) {
    const v = like?.getAttribute(a)
    if (v) svg.setAttribute(a, v)
  }
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'currentColor')
  const r = doc.createElementNS(SVG_NS, 'rect')
  r.setAttribute('x', '4')
  r.setAttribute('y', '4')
  r.setAttribute('width', '16')
  r.setAttribute('height', '16')
  r.setAttribute('rx', '3')
  svg.appendChild(r)
  return svg
}

export interface StopButtonDeps {
  stopAll: () => void
  showTip: (b: HTMLElement) => void
  hideTip: () => void
}

/**
 * 押したら VoiceCord の音をすべて止める。止める操作なので合成イベントでも効かせる。
 * 純正のポップアウトのハンドラには届かせない。押しっぱなしのキーリピートでは連発しない
 */
export function wireSoundboardStopButton(b: HTMLElement, deps: StopButtonDeps): HTMLElement {
  const stop = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    deps.hideTip()
    deps.stopAll()
  }
  b.addEventListener('click', stop)
  b.addEventListener('keydown', (e) => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return
    if (e.repeat) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    stop(e)
  })
  b.addEventListener('pointerenter', () => deps.showTip(b))
  b.addEventListener('pointerleave', () => deps.hideTip())
  b.addEventListener('focus', () => deps.showTip(b))
  b.addEventListener('blur', () => deps.hideTip())
  return b
}

export function buildSoundboardStopButton(doc: Document, volume: HTMLElement): HTMLElement {
  const b = doc.createElement('div')
  b.className = stripStateTokens(volume.className)
  b.setAttribute('role', 'button')
  b.setAttribute('tabindex', '0')
  b.setAttribute('aria-label', SOUNDBOARD_STOP_LABEL)
  b.setAttribute(GRAFT_ATTR, SOUNDBOARD_STOP_MARK)
  b.appendChild(createStopIcon(doc, volume.querySelector('svg')))
  return b
}
