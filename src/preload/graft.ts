import { GRAFT_ATTR, type AnchorHit, type AnchorTier } from './anchor.js'

/**
 * 純正のサウンドボードボタンの隣に VoiceCord のボタンを接ぎ木し、消されたら戻す。
 *
 * Discord の DOM は React が持っているので、チャンネル移動や再レンダリングで
 * 我々のノードは普通に外される。MutationObserver で監視して戻すが、ここには
 * 落とし穴がいくつかある。
 *
 *   1. **自己トリガ。** 自分の挿入も MutationObserver に届く。無視しないと
 *      「挿入 → 通知 → 挿入」の無限ループになり、Discord ごと固まる
 *   2. **取り合い。** React が我々のノードを外し続ける構造だと、戻すたびに外される。
 *      頻度に上限を設け、超えたら諦めて FAB に退避する（一定時間後に 1 回だけ再試行）
 *   3. **走査の重さ。** Discord の DOM はチャットの受信だけでも頻繁に変わる。
 *      接ぎ木できていて隣接関係が崩れていなければ、全文書の探索は省く
 *
 * #vc-root の中（React のポップアウト描画）の変化も無視する。再生中は毎秒何度も
 * 書き換わるので、拾うと無駄に探索が走る。
 */

export interface GraftState {
  /** 何段目でアンカーを見つけたか。見つかっていなければ null */
  tier: AnchorTier | null
  /** 接ぎ木したボタン。DOM に入っていなければ null */
  button: HTMLElement | null
  /** 起動からの挿入回数（初回を含む） */
  inserts: number
  /** 頻度の上限を超えて諦めた */
  tripped: boolean
}

export interface GraftDeps {
  doc: Document
  find: () => AnchorHit | null
  /** ボタンを作る。アンカーを渡すので見た目を写してよい */
  build: (anchor: HTMLElement) => HTMLElement
  /** アンカーの見た目が変わったとき、既存のボタンに写し直す */
  refresh: (button: HTMLElement, anchor: HTMLElement) => void
  onChange: (s: GraftState) => void
  now: () => number
  /** 変化をまとめて 1 回の探索にする。既定は requestAnimationFrame */
  schedule?: (fn: () => void) => void
  /** 諦めた後の再試行の予約。既定は setTimeout */
  setTimer?: (fn: () => void, ms: number) => void
  /** この要素の中の変化は無視する（#vc-root） */
  ignoreWithin?: Node | null
  maxInserts?: number
  windowMs?: number
}

export interface Graft {
  start(): void
  stop(): void
  /**
   * 揃える。force が false なら、接ぎ木できていて隣接関係が崩れていないときは探索を省く。
   * 新しい採取結果が届いた・VC に入った、など探し直す理由があるときは true で呼ぶ
   */
  sync(force?: boolean): void
  state(): GraftState
}

export const MAX_INSERTS_PER_WINDOW = 10
export const INSERT_WINDOW_MS = 1000
/** 諦めてから再試行するまで。再試行は 1 回だけ（取り合いが続くなら FAB のまま） */
export const RETRY_AFTER_TRIP_MS = 60_000

export function createGraft(deps: GraftDeps): Graft {
  const maxInserts = deps.maxInserts ?? MAX_INSERTS_PER_WINDOW
  const windowMs = deps.windowMs ?? INSERT_WINDOW_MS
  const schedule =
    deps.schedule ??
    ((fn: () => void) => {
      const w = deps.doc.defaultView
      if (w?.requestAnimationFrame) w.requestAnimationFrame(() => fn())
      else setTimeout(fn, 16)
    })
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))

  let button: HTMLElement | null = null
  let anchor: HTMLElement | null = null
  let tier: AnchorTier | null = null
  let inserts = 0
  let tripped = false
  let retried = false
  let stopped = true
  const recent: number[] = []
  let observer: MutationObserver | null = null
  let pending = false
  let last = ''

  const snapshot = (): GraftState => ({
    tier,
    button: button?.isConnected ? button : null,
    inserts,
    tripped
  })

  const emit = (): void => {
    const s = snapshot()
    const key = `${s.tier}|${s.button ? 1 : 0}|${s.inserts}|${s.tripped}`
    if (key === last) return
    last = key
    deps.onChange(s)
  }

  const detach = (): void => {
    if (button?.isConnected) button.remove()
  }

  const isNoise = (records: MutationRecord[]): boolean =>
    records.every((r) => {
      if (deps.ignoreWithin && deps.ignoreWithin.contains(r.target)) return true
      const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]
      // 自分のボタンの出し入れだけで起きた通知。ただしボタンが DOM から消えているなら
      // 誰かに外されたので noise ではない（戻す必要がある）
      return nodes.length > 0 && nodes.every((n) => n === button) && button?.isConnected === true
    })

  const observe = (): void => {
    if (observer !== null) return
    const body = deps.doc.body
    if (!body) return
    const MO = deps.doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
    observer = new MO((records) => {
      if (stopped || isNoise(records)) return
      if (pending) return
      pending = true
      schedule(() => {
        pending = false
        sync(false)
      })
    })
    observer.observe(body, { childList: true, subtree: true })
  }

  const trip = (): void => {
    tripped = true
    observer?.disconnect()
    observer = null
    detach()
    tier = null
    anchor = null
    if (retried) return
    retried = true
    setTimer(() => {
      if (stopped) return
      tripped = false
      recent.length = 0
      observe()
      sync(true)
    }, RETRY_AFTER_TRIP_MS)
  }

  function sync(force = false): void {
    if (stopped || tripped) return

    // 接ぎ木できていて、純正ボタンがまだ DOM にあり、隣にいるなら探し直さない
    if (!force && button?.isConnected && anchor?.isConnected && button.previousElementSibling === anchor) {
      deps.refresh(button, anchor)
      emit()
      return
    }

    const hit = deps.find()
    if (hit === null) {
      // VC を抜けた・DM を開いた。純正のボタンが無いところには出さない
      detach()
      tier = null
      anchor = null
      emit()
      return
    }
    tier = hit.tier
    anchor = hit.anchor
    if (button === null) button = deps.build(hit.anchor)
    else deps.refresh(button, hit.anchor)

    if (button.isConnected && button.previousElementSibling === hit.anchor) {
      emit()
      return
    }

    const t = deps.now()
    while (recent.length > 0 && t - (recent[0] as number) > windowMs) recent.shift()
    if (recent.length >= maxInserts) {
      trip()
      emit()
      return
    }
    recent.push(t)
    inserts += 1
    hit.anchor.after(button)
    emit()
  }

  return {
    start: () => {
      stopped = false
      if (tripped) return
      observe()
      sync(true)
    },
    stop: () => {
      stopped = true
      pending = false
      observer?.disconnect()
      observer = null
      detach()
    },
    sync,
    state: snapshot
  }
}

/** アンカーの見た目を写すときに外す属性。React の管理情報や、純正ポップアウトとの結び付き */
const DROP_ATTRS = ['id', 'aria-controls', 'aria-expanded', 'aria-describedby', 'aria-label', 'data-migration-pending']

/** 純正のポップアウトを開いている間だけ付くクラス（greyButtonActive_xxx など）は写さない */
export function stripStateTokens(className: string): string {
  return className
    .split(/\s+/)
    .filter((t) => t !== '' && !/active/i.test(t))
    .join(' ')
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** VoiceCord のアイコン。音の波形を 5 本の縦棒で表す（絵文字は使わない） */
export function createIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'currentColor')
  const bars: Array<[number, number]> = [
    [3, 9],
    [7.5, 5],
    [12, 2],
    [16.5, 6],
    [21, 10]
  ]
  for (const [cx, y] of bars) {
    const r = doc.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(cx - 1.25))
    r.setAttribute('y', String(y))
    r.setAttribute('width', '2.5')
    r.setAttribute('height', String(24 - y * 2))
    r.setAttribute('rx', '1.25')
    svg.appendChild(r)
  }
  return svg
}

/**
 * アンカーを写してボタンを作る。
 *
 * クラス名はハードコードせず、隣の純正ボタンから実行時にコピーする。cloneNode は
 * DOM の属性だけを複製し、React の内部情報（fiber など JS のプロパティ）は写らないので、
 * 純正のボタンとして振る舞うことはない。lottie のアイコンだけを自前の SVG に差し替える。
 */
export function buildGraftButton(doc: Document, anchor: HTMLElement, label: string): HTMLElement {
  const button = anchor.cloneNode(true) as HTMLElement
  for (const a of DROP_ATTRS) button.removeAttribute(a)
  button.className = stripStateTokens(anchor.className)
  button.setAttribute('type', 'button')
  button.setAttribute('aria-label', label)
  button.setAttribute(GRAFT_ATTR, 'graft')
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', 'false')
  // 複製した子孫の id（lottie の clipPath など）が重複しないよう、アイコンごと差し替える
  for (const el of Array.from(button.querySelectorAll('[id]'))) el.removeAttribute('id')
  const iconHost = button.querySelector('[class*="lottieIcon"]') ?? button.querySelector('svg')?.parentElement
  if (iconHost && iconHost !== button) {
    iconHost.replaceChildren(createIcon(doc))
  } else {
    button.replaceChildren(createIcon(doc))
  }
  return button
}

/** アンカーのクラスが変わったら写し直す（テーマ切替や Discord の状態クラス） */
export function refreshGraftButton(button: HTMLElement, anchor: HTMLElement): void {
  const next = stripStateTokens(anchor.className)
  if (button.className !== next) button.className = next
}
