/**
 * キーボードの封じ込め。
 *
 * これが無いと、パネル内のテキスト入力中に Discord のショートカットが暴発する
 * （チャンネル移動、ミュート、「打ち始めるとチャット欄にフォーカス」など）。
 *
 * リスナーは root ではなく document に capture 段階で張る必要がある。
 * root に張ると、祖先である document の capture リスナー（Discord のもの）が
 * 先に走ってしまう。同じ document 上では登録順に走るので、preload の段階で
 * 登録しておけば Discord のアプリコードより先に取れる。
 *
 * 止めるのは stopImmediatePropagation。stopPropagation だけだと同じ document に
 * 登録された Discord 側のリスナーには届いてしまう。
 */

export interface KeyboardTarget {
  addEventListener(type: string, listener: (e: Event) => void, options: { capture: true }): void
  removeEventListener(type: string, listener: (e: Event) => void, options: { capture: true }): void
}

export interface ContainOptions {
  /** UI のルート要素。ここの中で起きたキー入力だけを止める */
  root: { contains(node: Node | null): boolean }
  /** パネルが開いているか。閉じているときは何もしない */
  isOpen: () => boolean
}

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const

/** 封じ込めを開始する。戻り値を呼ぶと解除できる。 */
export function containKeyboard(target: KeyboardTarget, opts: ContainOptions): () => void {
  const handler = (e: Event): void => {
    if (!opts.isOpen()) return
    const node = e.target as Node | null
    if (!opts.root.contains(node)) return
    e.stopImmediatePropagation()
  }
  for (const type of KEY_EVENTS) target.addEventListener(type, handler, { capture: true })
  return () => {
    for (const type of KEY_EVENTS) target.removeEventListener(type, handler, { capture: true })
  }
}

export interface Hotkey {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** KeyboardEvent.code（レイアウト非依存。'KeyB' など） */
  code: string
}

export const DEFAULT_HOTKEY: Hotkey = { ctrl: true, shift: true, alt: false, code: 'KeyB' }

export interface KeyLike {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  code: string
  repeat?: boolean
}

/**
 * ホットキーに一致するか。
 * KeyboardEvent.key ではなく code で見る。key だと日本語配列や IME の状態で変わる。
 */
export function matchesHotkey(e: KeyLike, hk: Hotkey): boolean {
  if (e.repeat) return false
  if (e.metaKey) return false
  return e.ctrlKey === hk.ctrl && e.shiftKey === hk.shift && e.altKey === hk.alt && e.code === hk.code
}
