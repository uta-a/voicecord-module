/**
 * キーボードの封じ込め。
 *
 * これが無いと、ポップアウト内のテキスト入力中に Discord のショートカットが暴発する
 * （チャンネル移動、ミュート、「打ち始めるとチャット欄にフォーカス」など）。
 *
 * リスナーは root ではなく document に capture 段階で張る必要がある。
 * root に張ると、祖先である document の capture リスナー（Discord のもの）が
 * 先に走ってしまう。同じ document 上では登録順に走るので、preload の段階で
 * 登録しておけば Discord のアプリコードより先に取れる。
 *
 * 止めるのは stopImmediatePropagation。stopPropagation だけだと同じ document に
 * 登録された Discord 側のリスナーには届いてしまう。
 *
 * M4.5 でページ内ホットキー（Ctrl+Shift+B）による開閉は廃止した。入口は純正
 * サウンドボードボタンの隣のボタンになった。
 */

export interface KeyboardTarget {
  addEventListener(type: string, listener: (e: Event) => void, options: { capture: true }): void
  removeEventListener(type: string, listener: (e: Event) => void, options: { capture: true }): void
}

export interface ContainOptions {
  /** UI のルート要素。ここの中で起きたキー入力だけを止める */
  root: { contains(node: Node | null): boolean }
  /** 封じ込めるべき UI が開いているか。閉じているときは何もしない */
  isOpen: () => boolean
  /** true を返したキーは止めずに通す（入れ子のレイヤーの Esc を Radix に届けるため） */
  passThrough?: (e: Event) => boolean
}

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const

/** 封じ込めを開始する。戻り値を呼ぶと解除できる。 */
export function containKeyboard(target: KeyboardTarget, opts: ContainOptions): () => void {
  const handler = (e: Event): void => {
    if (!opts.isOpen()) return
    const node = e.target as Node | null
    if (!opts.root.contains(node)) return
    if (opts.passThrough?.(e)) return
    e.stopImmediatePropagation()
  }
  for (const type of KEY_EVENTS) target.addEventListener(type, handler, { capture: true })
  return () => {
    for (const type of KEY_EVENTS) target.removeEventListener(type, handler, { capture: true })
  }
}

/**
 * 開いているレイヤー（Radix の Dialog / Popover / Select の中身）。
 *
 * 封じ込めの判定を「ポップアウトが開いているか」だけにすると、ポップアウトの外にある
 * LevelDialog などを開いたときに外れる（ダイアログがポップアウトを閉じた瞬間、あるいは
 * VC を抜けてアンカーが消えた瞬間に isOpen が false になる）。DOM に実際に開いている
 * レイヤーがあるかで見る。
 */
const OPEN_LAYER = '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]'

export function hasOpenLayer(root: ParentNode): boolean {
  return root.querySelector(OPEN_LAYER) !== null
}

/** フォーカスが属するレイヤーを判定するときの対象 */
const LAYER_ROLE = '[role="dialog"], [role="listbox"], [role="menu"], [role="alertdialog"]'

/** ポップアウト本体に付くクラス（SoundboardPopout.tsx） */
export const POPOUT_CLASS = 'vc-popout'

export type EscapeAction = 'close-popout' | 'close-diag' | 'pass'

export interface EscapeInput {
  active: Element | null
  root: Node
  popoutOpen: boolean
  diagOpen: boolean
}

/**
 * Esc を誰が処理するか。
 *
 * フォーカスがポップアウトの中の入れ子のレイヤー（音量の Popover、LevelDialog など）に
 * あるときは、手前のレイヤーだけを閉じるのが期待される動き。ここでポップアウトごと
 * 閉じてしまわず、Radix に任せる。
 */
export function escapeAction(i: EscapeInput): EscapeAction {
  const active = i.active
  if (active && i.root.contains(active)) {
    const layer = active.closest(LAYER_ROLE)
    if (layer && i.root.contains(layer) && !layer.classList.contains(POPOUT_CLASS)) return 'pass'
  }
  if (i.popoutOpen) return 'close-popout'
  if (i.diagOpen) return 'close-diag'
  return 'pass'
}
