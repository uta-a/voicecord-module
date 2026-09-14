import {
  HARVEST_REQUEST_EVENT,
  HARVEST_RESULT_EVENT,
  parseHarvestDetail,
  type ActionButtonClasses,
  type HarvestResult
} from '../shared/harvest.js'

/**
 * 純正のサウンドボードボタン（アンカー）を探す。
 *
 * 上の段から順に試し、**何段目で見つかったかを返す**。下の段ほど Discord の更新で
 * 壊れやすいので、2 段目以下に落ちたことは「まだ動くが次の更新で出なくなりうる」の
 * 前兆として状態に出す。
 *
 *   1. 採取役が webpack から引いた CSS モジュールのクラス名（Vencord と同じ根拠）
 *   2. クラス名のハッシュ前の部分（`actionButtons_`）で照合
 *   3. aria-label の文言の完全一致（サウンドボードを開く / Open Soundboard）
 *   4. 構造: lottie アイコンのボタンが 4 つ以上並ぶ列の最後（VC 中だけ試す）
 *
 * 1・2 段目は、列の中で**文言が一致するボタン**か、文言が無ければ**構造条件を満たす列の
 * 最後のボタン**だけを採る。クラス名で見つけた列でも確からしさを確かめる。同じ CSS
 * モジュールの列が別の画面にもありうることと、1 段目のクラス名はページ側から偽の値を
 * 送られうる（任意の位置に接ぎ木させない）ことが理由。
 *
 * 計画では 2 段目を `expression-picker-chat-input-button` にしていたが、2026-09-14 の
 * Canary 1.0.1169 の実測で、これはチャット欄の絵文字ピッカー側のクラスで、音声パネルの
 * サウンドボードボタンには付いていないと分かったので使わない。
 *
 * 見つからなくても throw しない（Vencord の作法）。ただし握りつぶさず、null を返して
 * 呼び出し側に「何段目でも見つからなかった」を持たせる。
 */

export type AnchorTier = 1 | 2 | 3 | 4

export interface AnchorHit {
  anchor: HTMLElement
  tier: AnchorTier
}

/** 接ぎ木したボタンに付ける印。自分自身をアンカーと取り違えないため */
export const GRAFT_ATTR = 'data-voicecord'

/** 純正ボタンの文言。部分一致にすると「サウンドボードの音量」などに付く */
export const SOUNDBOARD_LABELS: ReadonlySet<string> = new Set(['サウンドボードを開く', 'Open Soundboard'])

/** 文言が無い列を音声パネルと見なすのに要る lottie ボタンの数（ユーザーパネルは 3 つ） */
const MIN_LOTTIE_BUTTONS = 4

export interface FindOptions {
  /** 採取役から届いたクラス名（検証済み）。無ければ 1 段目を飛ばす */
  classes: ActionButtonClasses | null
  /** 探索から外す要素（#vc-root） */
  ignoreWithin?: Node | null
  /** VC 中か。4 段目（全文書の構造走査）は VC 中だけ行う */
  inVc?: boolean
}

function isOurs(el: Element, ignoreWithin: Node | null | undefined): boolean {
  if (el.hasAttribute(GRAFT_ATTR)) return true
  return ignoreWithin != null && ignoreWithin.contains(el)
}

function directButtons(container: Element, ignoreWithin: Node | null | undefined): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of Array.from(container.children)) {
    if (child.tagName === 'BUTTON' && !isOurs(child, ignoreWithin)) out.push(child as HTMLElement)
  }
  return out
}

function hasLabel(b: Element): boolean {
  return SOUNDBOARD_LABELS.has(b.getAttribute('aria-label') ?? '')
}

function labelledButton(container: Element, ignoreWithin: Node | null | undefined): HTMLElement | null {
  return directButtons(container, ignoreWithin).find(hasLabel) ?? null
}

/** 構造条件を満たす列なら、その最後の lottie ボタン */
function structuralButton(container: Element, ignoreWithin: Node | null | undefined): HTMLElement | null {
  const withIcon = directButtons(container, ignoreWithin).filter((b) => b.querySelector('[class*="lottieIcon"]'))
  return withIcon.length >= MIN_LOTTIE_BUTTONS ? (withIcon[withIcon.length - 1] ?? null) : null
}

/** 列の中からサウンドボードのボタンを選ぶ。文言の一致を優先し、無ければ構造条件で */
export function pickSoundboardButton(container: Element, ignoreWithin?: Node | null): HTMLElement | null {
  return labelledButton(container, ignoreWithin) ?? structuralButton(container, ignoreWithin)
}

/** 複数の列から選ぶ。まず全列から文言の一致を探し、無ければ構造条件を満たす列を探す */
function pickFromContainers(containers: Element[], ignoreWithin: Node | null | undefined): HTMLElement | null {
  const usable = containers.filter((c) => !isOurs(c, ignoreWithin))
  for (const c of usable) {
    const b = labelledButton(c, ignoreWithin)
    if (b) return b
  }
  for (const c of usable) {
    const b = structuralButton(c, ignoreWithin)
    if (b) return b
  }
  return null
}

function firstToken(classList: string): string {
  return classList.split(/\s+/)[0] ?? ''
}

function cssEscape(s: string): string {
  // sanitizeClassList で [A-Za-z0-9_-] に絞ってあるのでエスケープは不要だが、
  // CSS.escape がある環境では使う
  // CSS.escape は CSS に付けたまま呼ぶ。取り出して呼ぶと Chrome でも Illegal invocation で落ちる
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  return typeof css?.escape === 'function' ? css.escape(s) : s
}

export function findSoundboardAnchor(doc: ParentNode, opts: FindOptions): AnchorHit | null {
  const ignore = opts.ignoreWithin

  // 1 段目: 採取役のクラス名（見つけた列でも文言か構造で確かめる）
  const token = opts.classes?.actionButtons ? firstToken(opts.classes.actionButtons) : ''
  if (token !== '') {
    const b = pickFromContainers(Array.from(doc.querySelectorAll(`.${cssEscape(token)}`)), ignore)
    if (b) return { anchor: b, tier: 1 }
  }

  // 2 段目: ハッシュ前の部分
  {
    const b = pickFromContainers(Array.from(doc.querySelectorAll('[class*="actionButtons_"]')), ignore)
    if (b) return { anchor: b, tier: 2 }
  }

  // 3 段目: 文言の完全一致
  for (const b of Array.from(doc.querySelectorAll<HTMLElement>('button[aria-label]'))) {
    if (isOurs(b, ignore)) continue
    if (hasLabel(b)) return { anchor: b, tier: 3 }
  }

  // 4 段目: 構造。全文書を走査するので VC 中だけ
  if (opts.inVc) {
    const seen = new Set<Element>()
    for (const icon of Array.from(doc.querySelectorAll('button [class*="lottieIcon"]'))) {
      const container = icon.closest('button')?.parentElement
      if (!container || seen.has(container) || isOurs(container, ignore)) continue
      seen.add(container)
      const b = structuralButton(container, ignore)
      if (b) return { anchor: b, tier: 4 }
    }
  }

  return null
}

export interface HarvestClient {
  /** 検証済みのクラス名。まだ届いていなければ null */
  classes(): ActionButtonClasses | null
  /** 直近の結果（診断用） */
  last(): HarvestResult | null
  /** 結果を受け取った回数。「引き直した後もまだ下の段か」の判定に使う */
  results(): number
  /** 引き直しを頼む。連打しないよう間隔を空け、呼び出し元の処理が終わってから投げる */
  request(): void
  /** 結果が届いたときの通知。連打は間引き、最後の 1 回は必ず届ける */
  onResult(cb: () => void): () => void
}

export interface HarvestClientDeps {
  doc: Pick<Document, 'addEventListener' | 'dispatchEvent'>
  makeEvent: (type: string) => Event
  now: () => number
  /** 引き直しの最短間隔 */
  minIntervalMs?: number
  /** 結果の通知の最短間隔 */
  minNotifyMs?: number
  setTimer?: (fn: () => void, ms: number) => void
}

export function createHarvestClient(deps: HarvestClientDeps): HarvestClient {
  const minInterval = deps.minIntervalMs ?? 2000
  const minNotify = deps.minNotifyMs ?? 500
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))
  let lastResult: HarvestResult | null = null
  let count = 0
  let lastRequestAt = -Infinity
  let lastNotifyAt = -Infinity
  let trailing = false
  const listeners = new Set<() => void>()

  const notify = (): void => {
    lastNotifyAt = deps.now()
    for (const l of [...listeners]) l()
  }

  deps.doc.addEventListener(HARVEST_RESULT_EVENT, (e: Event) => {
    const parsed = parseHarvestDetail((e as CustomEvent).detail)
    if (parsed === null) return // 形の違う値は捨てる（ページ上の誰でも投げられる）
    lastResult = parsed
    count += 1
    // ページ側から連打されても、探索と再描画を連打しない
    const elapsed = deps.now() - lastNotifyAt
    if (elapsed >= minNotify) {
      notify()
      return
    }
    if (trailing) return
    trailing = true
    setTimer(() => {
      trailing = false
      notify()
    }, minNotify - elapsed)
  })

  return {
    classes: () => lastResult?.classes ?? null,
    last: () => lastResult,
    results: () => count,
    request: () => {
      const t = deps.now()
      if (t - lastRequestAt < minInterval) return
      lastRequestAt = t
      // 同期で投げると、採取役の返事と onResult が呼び出し元の処理の途中に入れ子で走り、
      // 呼び出し元が古い状態で上書きする
      setTimer(() => void deps.doc.dispatchEvent(deps.makeEvent(HARVEST_REQUEST_EVENT)), 0)
    },
    onResult: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
