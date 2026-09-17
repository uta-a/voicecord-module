import { isSoundboardSoundId } from '../shared/soundboard.js'
import { ROOT_ID } from './shell.js'

/**
 * 純正サウンドボードの「Nitro が必要なサウンド」（ほかのサーバーのサウンド）を横取りする。
 *
 * ロックされたサウンドを押すと、純正は Nitro の勧誘を出すだけで鳴らさない。設定が ON のときは
 * その押下を純正へ届けずに止め、VoiceCord の注入経路で鳴らす（音声の取得は main が行う）。
 *
 * 判定は DOM だけで行う（Canary 1.0.1175 で確認した構造）:
 *   - 純正サウンドボードのポップアウト（role="dialog"）の中のボタン本体（soundButton__）である
 *   - li（soundButtonWrapper）の中に lockIcon の svg がある = ロックされている
 *     （Nitro 不足か、サーバーの管理者が外部のサウンドを禁止しているかは区別しない）
 *   - プレビュー・お気に入り（secondaryButton）の上ではない
 *   - `id="sound-<数字>"` がサウンド ID
 * クラス名はハッシュ付きなので接頭辞で見る（anchor.ts と同じ流儀）。
 *
 * Discord の要素には属性もスタイルも足さない。ロックアイコンと Nitro の装飾・誘導は html の印と
 * CSS だけで隠す（cameraButton.ts と同じ作り）。
 */

export const UNLOCK_SOUNDBOARD_ATTR = 'data-voicecord-unlock-soundboard'

/** 各セレクタに html の印を前置きする。カンマ区切りの 1 つでも漏れると、設定 OFF でも効いてしまう */
const gated = (selectors: string[], body: string): string =>
  `${selectors.map((s) => `html[${UNLOCK_SOUNDBOARD_ATTR}] ${s}`).join(',')}{${body}}`

/** クラス名は Canary 1.0.1175 の実測（ハッシュ部分を除いて合わせる） */
export const UNLOCK_SOUNDBOARD_CSS = [
  // サウンドボタンの鍵
  gated(['[class*="soundButton__"] svg[class*="lockIcon"]'], 'display:none !important'),
  // ほかのサーバーの行のピンクのグラデーション
  gated(['[class*="soundRowNitroLocked"]'], 'background:none !important'),
  // セクション見出し。NitroLockedBackground が background ショートハンドでグラデーションに上書きしているので、
  // 通常の sectionContainer と同じ地の色へ戻す
  gated(['[class*="sectionContainerNitroLockedBackground"]'], 'background:var(--background-base-low) !important'),
  // セクション末尾（nitroLocked__ と lastSectionFooter / smallPaddingFooter の組）。
  // *="nitroLocked__" だと soundRowNitroLocked__ などにも当たるので、class の単語の頭で合わせる
  gated(['[class^="nitroLocked__"]', '[class*=" nitroLocked__"]'], 'background:none !important'),
  // セクション上の南京錠の区切り線
  gated(['[class*="nitroTopDividerContainer"]'], 'display:none !important'),
  // ポップアウト下端の「Nitro で盛り上がろう / Nitro をゲット」
  gated(['[role="dialog"] [class*="upsellContainerFloating"]'], 'display:none !important'),
  // 左のカテゴリ列のサーバーアイコンの鍵
  gated(['[class*="categoryItemLockIconContainer"]'], 'display:none !important')
].join('')

export function setSoundboardUnlocked(doc: Document, on: boolean): void {
  if (on) doc.documentElement.setAttribute(UNLOCK_SOUNDBOARD_ATTR, '')
  else doc.documentElement.removeAttribute(UNLOCK_SOUNDBOARD_ATTR)
}

/**
 * 設定と UI の有無から、横取りするか・html に印を付けるかを決める。
 * UI が無ければ鳴らす先が無いので、設定 ON でも純正の動き（と見た目）のまま残す。
 */
export function decideSoundboardUnlock(s: { setting: boolean; uiMounted: boolean }): {
  intercept: boolean
  markHtml: boolean
} {
  const on = s.setting && s.uiMounted
  return { intercept: on, markHtml: on }
}

export interface LockedSound {
  soundId: string
  name: string
}

/** 画面に出す名前の上限。ページ側の DOM 由来の文字列なので、長さだけは抑える */
const MAX_NAME_LENGTH = 100

/** target がロックされたサウンドのボタン本体の中なら、その ID と名前を返す */
export function findLockedSound(target: EventTarget | null): LockedSound | null {
  // Node かどうかは instanceof で見ない（isolated world とページで Element の実体が別になりうる）
  const el = target as Element | null
  if (el === null || typeof (el as { closest?: unknown }).closest !== 'function') return null
  // 自前 UI（ポップアウト）の中の出来事は横取りしない
  if (el.closest(`#${ROOT_ID}`)) return null
  const button = el.closest('[class*="soundButton__"]')
  if (button === null) return null
  // 表示中の純正サウンドボードのポップアウトの中だけ（サーバー設定のサウンド一覧などは横取りしない）
  if (button.closest('[role="dialog"]') === null) return null
  // プレビューとお気に入りは純正のまま使えるようにする
  if (el.closest('[class*="secondaryButton"]')) return null
  const li = button.closest('[class*="soundButtonWrapper"]')
  if (li === null || li.querySelector('svg[class*="lockIcon"]') === null) return null
  const idEl = button.querySelector('[id^="sound-"]')
  const soundId = idEl?.id.slice('sound-'.length) ?? ''
  if (!isSoundboardSoundId(soundId)) return null
  const name = (button.querySelector('[class*="soundName"]')?.textContent ?? '').trim().slice(0, MAX_NAME_LENGTH)
  return { soundId, name }
}

export interface LockedSoundInterceptorOptions {
  /** 設定が ON か。OFF のときは一切触らない */
  enabled: () => boolean
  onPlay: (sound: LockedSound) => void
  /** 本物の入力か。テストで差し替えるためだけの口で、既定は event.isTrusted */
  isTrusted?: (e: Event) => boolean
}

/** 純正のハンドラが反応しうる入力。押し始めから止めないと、勧誘が先に開く */
const POINTER_EVENTS = ['pointerdown', 'mousedown', 'click'] as const
/** 純正の role="button" は keyup で反応することがあるので、両方止める */
const KEY_EVENTS = ['keydown', 'keyup'] as const

/**
 * window の capture 段階で横取りする。window は document より先に走るので、Discord（React の
 * ルートや document のリスナー）より必ず前に止められる。止めるのは stopImmediatePropagation
 * （keyboard.ts と同じ理由）。戻り値を呼ぶと解除する。
 */
export function installLockedSoundInterceptor(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  opts: LockedSoundInterceptorOptions
): () => void {
  const isTrusted = opts.isTrusted ?? ((e: Event) => e.isTrusted)

  const onPointer = (e: Event): void => {
    // 左ボタンだけ。右クリックのメニューなどは純正のまま使えるようにする
    if ((e as MouseEvent).button !== 0) return
    if (!opts.enabled()) return
    const sound = findLockedSound(e.target)
    if (sound === null) return
    e.preventDefault()
    e.stopImmediatePropagation()
    // 鳴らすのはクリック 1 回につき 1 回だけ。VC へ音を流す操作なので、ページ側スクリプトの
    // 合成イベントでは鳴らさない（src/ui/lib/trusted.ts と同じ方針）。純正の勧誘は合成でも止める
    if (e.type === 'click' && isTrusted(e)) opts.onPlay(sound)
  }

  const onKey = (e: Event): void => {
    const key = (e as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
    if (!opts.enabled()) return
    const sound = findLockedSound(e.target)
    if (sound === null) return
    e.preventDefault()
    e.stopImmediatePropagation()
    // 鳴らすのは keydown だけ。押しっぱなしの自動リピートで連打にしない
    if (e.type === 'keydown' && !(e as KeyboardEvent).repeat && isTrusted(e)) opts.onPlay(sound)
  }

  for (const type of POINTER_EVENTS) win.addEventListener(type, onPointer, { capture: true })
  for (const type of KEY_EVENTS) win.addEventListener(type, onKey, { capture: true })
  return () => {
    for (const type of POINTER_EVENTS) win.removeEventListener(type, onPointer, { capture: true })
    for (const type of KEY_EVENTS) win.removeEventListener(type, onKey, { capture: true })
  }
}

/** 純正の再生中の枠と同じ色（Canary 1.0.1177 の実測: .soundButtonInteractive.playing） */
const PLAYING_BORDER = 'var(--status-positive-background, hsl(151.4 100% 25.1%))'

/**
 * VoiceCord で鳴らしている純正サウンドボードのサウンドに、純正の再生中と同じ緑の枠を付ける CSS。
 * Discord の要素には触らず、サウンド ID ごとのセレクタを生成して差し替える。ID は数字だけを通す
 */
export function playingSoundboardCss(ids: readonly string[]): string {
  const safe = [...new Set(ids)].filter(isSoundboardSoundId)
  if (safe.length === 0) return ''
  const selectors = safe.map((id) => `[role="dialog"] [class*="soundButton__"]:has(> [id="sound-${id}"])`)
  return `${selectors.join(',')}{border-color:${PLAYING_BORDER} !important}`
}
