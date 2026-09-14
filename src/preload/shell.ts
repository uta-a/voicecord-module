import type { EngineState, VoiceCordStatus } from '../shared/ipc.js'
import { DOT_LABEL, statusProblems } from '../shared/status.js'

export { DOT_LABEL, statusProblems }

/**
 * Discord の画面に生やす器。
 *
 * M4.5 で VoiceCord の入口は「純正サウンドボードボタンの隣に接ぎ木したボタン」になり、
 * 中身は Discord のサウンドボードと同じ意匠のポップアウト（React、Radix Popover）になった。
 * 器に残るのは次の 4 つだけ。
 *
 *   - #vc-root: スタイルのスコープと、ポップアウト／ダイアログの Portal の行き先
 *   - FAB: **故障したときだけ**出す予備の入口（presence.ts が判定する）。平常時に出すと
 *     VC 全画面の「ポップアウト」ボタンなど Discord の操作を塞ぐ
 *   - 診断の箱: UI 自体が読み込めなかったとき、FAB から理由を読むための最小限の表示
 *   - ツールチップ: 接ぎ木したボタンの「VoiceCord」。純正と同じ意匠で、区別はここだけ
 */

export const ROOT_ID = 'vc-root'

/**
 * Radix の Portal の行き先。既定の document.body へ出すと #vc-root の外になり、
 * #vc-root にスコープした Tailwind が一切効かない。
 */
export const PORTAL_CLASS = 'vc-portal'

/** エンジンの状態と FAB の色の対応（可視化 2） */
export const DOT_COLOR: Record<EngineState, string> = {
  starting: '#8a8f98',
  searching: '#e8a33d',
  attached: '#3ba55d',
  failed: '#ed4245'
}

/**
 * 器のスタイル。Tailwind の出力とは別に、器そのものだけを賄う。
 * すべて #vc-root 配下に閉じ込め、Discord 側へ漏らさない。
 * 色は Discord のテーマ変数を参照し、全てにフォールバック値を持たせる
 * （Discord が変数名を変えても無色にならない）。
 */
export const SHELL_CSS = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  /* クリックを吸わない。中身だけが受け取る */
  pointer-events: none;
}
#${ROOT_ID} .vc-fab,
#${ROOT_ID} .vc-diag,
#${ROOT_ID} .${PORTAL_CLASS} {
  pointer-events: auto;
}
#${ROOT_ID} .vc-fab {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-subtle, rgba(151, 151, 159, 0.12));
  background: var(--background-surface-high, #242429);
  color: var(--text-default, #dbdee1);
  font: 500 13px/1 var(--font-primary, "gg sans", "Noto Sans", sans-serif);
  cursor: grab;
  user-select: none;
  box-shadow: var(--shadow-high, 0 12px 24px 0 rgba(0, 0, 0, 0.24));
}
#${ROOT_ID} .vc-fab[hidden] { display: none; }
#${ROOT_ID} .vc-fab:active { cursor: grabbing; }
#${ROOT_ID} .vc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${DOT_COLOR.starting};
  flex: none;
}
#${ROOT_ID} .vc-diag {
  position: absolute;
  display: none;
  max-width: min(420px, calc(100vw - 32px));
  padding: 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--background-surface-high, #242429);
  color: var(--text-default, #dbdee1);
  font: 400 14px/1.5 var(--font-primary, "gg sans", "Noto Sans", sans-serif);
  box-shadow: var(--shadow-border, 0 0 0 1px rgba(255, 255, 255, 0.08)), var(--shadow-high, 0 12px 24px 0 rgba(0, 0, 0, 0.24));
}
#${ROOT_ID} .vc-diag[data-open="true"] { display: block; }
#${ROOT_ID} .vc-reason {
  margin: 0 0 8px;
  font-size: 13px;
}
#${ROOT_ID} .vc-reason:empty { display: none; }
#${ROOT_ID} .vc-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}
#${ROOT_ID} .vc-kv dt { color: var(--text-muted, #949ba4); }
#${ROOT_ID} .vc-kv dd { margin: 0; word-break: break-all; }
#${ROOT_ID} .vc-error {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(237, 66, 69, 0.12);
  border: 1px solid rgba(237, 66, 69, 0.35);
  font-size: 13px;
  white-space: pre-wrap;
}
#${ROOT_ID} .vc-tip {
  position: fixed;
  transform: translate(-50%, calc(-100% - 8px));
  padding: 8px 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--background-surface-highest, #2e2e34);
  color: var(--text-strong, #fbfbfb);
  font: 500 14px/16px var(--font-primary, "gg sans", "Noto Sans", sans-serif);
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--shadow-border, 0 0 0 1px rgba(255, 255, 255, 0.08)), var(--shadow-high, 0 12px 24px 0 rgba(0, 0, 0, 0.24));
}
#${ROOT_ID} .vc-tip[hidden] { display: none; }
`

export interface Point {
  x: number
  y: number
}

/** 要素がビューポートから出ないように収める */
export function clampToViewport(p: Point, size: Point, viewport: Point): Point {
  const maxX = Math.max(0, viewport.x - size.x)
  const maxY = Math.max(0, viewport.y - size.y)
  return {
    x: Math.min(Math.max(0, p.x), maxX),
    y: Math.min(Math.max(0, p.y), maxY)
  }
}

export interface Shell {
  root: HTMLElement
  /** React のマウント先。ここは React だけが触る */
  body: HTMLElement
  /** Radix の Portal（ポップアウト・ダイアログ・セレクト）の行き先 */
  portal: HTMLElement
  /** 予備の入口。ポップアウトのアンカーにもなる */
  fab: HTMLElement
  /** DOM に入れたあとに呼ぶ。実寸が測れて初めて決まる位置を詰める */
  settle: () => void
  /** 診断の箱（UI が読み込めなかったとき用） */
  isOpen: () => boolean
  open: () => void
  close: () => void
  toggle: () => void
  setStatus: (s: VoiceCordStatus) => void
  /** FAB の表示。reason は FAB と診断の箱に出す */
  setFab: (visible: boolean, reason: string | null) => void
  /** FAB が押されたとき（ドラッグではなくクリック）。未設定なら診断の箱を開閉する */
  onFabClick: (cb: (() => void) | null) => void
  showTip: (target: Element, text: string) => void
  hideTip: () => void
  destroy: () => void
}

export interface ShellOptions {
  doc: Document
  /** FAB の初期位置。無ければ右下（Discord のユーザーパネルを避ける） */
  fabPos?: Point
  onMove?: (p: Point) => void
}

export function createShell(opts: ShellOptions): Shell {
  const { doc } = opts
  const root = doc.createElement('div')
  root.id = ROOT_ID

  const fab = doc.createElement('div')
  fab.className = 'vc-fab'
  fab.setAttribute('role', 'button')
  fab.setAttribute('tabindex', '0')
  const dot = doc.createElement('span')
  dot.className = 'vc-dot'
  const fabLabel = doc.createElement('span')
  fabLabel.textContent = 'VoiceCord'
  fab.append(dot, fabLabel)

  const diag = doc.createElement('div')
  diag.className = 'vc-diag'
  diag.dataset['open'] = 'false'
  const reason = doc.createElement('p')
  reason.className = 'vc-reason'
  const status = doc.createElement('div')
  status.className = 'vc-status'
  diag.append(reason, status)

  // React のマウント先。ポップアウトもダイアログも Portal で .vc-portal に出るので、
  // ここ自体は大きさを持たない
  const body = doc.createElement('div')
  body.className = 'vc-body'

  const tip = doc.createElement('div')
  tip.className = 'vc-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true

  // 最後に置く。位置指定済みの兄弟どうしは DOM 順で重なるので、ポップアウトや
  // ダイアログが FAB や診断の箱の下に潜らない
  const portal = doc.createElement('div')
  portal.className = PORTAL_CLASS

  root.append(fab, diag, body, tip, portal)

  const vp = viewportOf(doc)
  place(fab, opts.fabPos ?? { x: vp.x, y: vp.y })

  let fabClick: (() => void) | null = null

  const setOpen = (open: boolean): void => {
    diag.dataset['open'] = String(open)
    if (open) {
      const r = fab.getBoundingClientRect()
      place(diag, { x: Math.max(8, r.left - 200), y: Math.max(8, r.top - 220) })
      keepInView(diag, doc)
    }
  }
  const isOpen = (): boolean => diag.dataset['open'] === 'true'

  const stopFabDrag = makeDraggable(fab, fab, doc, opts.onMove, () => {
    if (fabClick) fabClick()
    else setOpen(!isOpen())
  })
  const onFabKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (fabClick) fabClick()
    else setOpen(!isOpen())
  }
  fab.addEventListener('keydown', onFabKey)

  let reasonText: string | null = null

  const setStatus = (s: VoiceCordStatus): void => {
    dot.style.background = DOT_COLOR[s.engine]
    const label = DOT_LABEL[s.engine]
    // どのプロセスがエンジンかを実機で判別できるようにする。Discord 自身も
    // node.mojom.NodeService を持っていて、コマンドラインでは区別できない
    fab.title =
      `VoiceCord — ${label}\n${s.discordBuild} ${s.discordVersion}` +
      (reasonText ? `\n${reasonText}` : '') +
      (s.attachedPid !== null ? `\naudio PID ${s.attachedPid}` : '') +
      (s.enginePid !== null ? `\nengine PID ${s.enginePid}` : '') +
      (s.sampleRate !== null
        ? `\n注入レート ${s.sampleRate} Hz（${s.frameSamples ?? '?'} サンプル）`
        : `\n注入レート 未計測`)
    renderStatus(doc, status, s)
  }

  return {
    root,
    body,
    portal,
    fab,
    settle: () => {
      if (opts.fabPos) return
      keepInView(fab, doc, FAB_MARGIN_PX)
    },
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    setStatus,
    setFab: (visible, text) => {
      fab.hidden = !visible
      reasonText = text
      reason.textContent = text ?? ''
      if (!visible) setOpen(false)
    },
    onFabClick: (cb) => {
      fabClick = cb
    },
    showTip: (target, text) => {
      const r = target.getBoundingClientRect()
      tip.textContent = text
      tip.style.left = `${r.left + r.width / 2}px`
      tip.style.top = `${r.top}px`
      tip.hidden = false
    },
    hideTip: () => {
      tip.hidden = true
    },
    destroy: () => {
      stopFabDrag()
      fab.removeEventListener('keydown', onFabKey)
      root.remove()
    }
  }
}

function renderStatus(doc: Document, body: HTMLElement, s: VoiceCordStatus): void {
  body.replaceChildren()

  // 正常に動いているときは何も出さない。平常時のシグナルはポップアウトの状態欄に任せ、
  // ここは「何かおかしいときに理由が読める場所」に徹する
  const problems = statusProblems(s)
  const healthy = s.engine === 'attached' && problems.length === 0
  body.hidden = healthy
  if (healthy) return

  const dl = doc.createElement('dl')
  dl.className = 'vc-kv'
  const rows: Array<[string, string]> = [
    ['状態', DOT_LABEL[s.engine]],
    ['ビルド', `${s.discordBuild} ${s.discordVersion}`],
    ['音声プロセス', s.attachedPid === null ? '未検出' : String(s.attachedPid)],
    ['エンジン', s.enginePid === null ? '起動していません' : `PID ${s.enginePid}`],
    [
      '注入レート',
      s.sampleRate === null
        ? '未計測'
        : `${s.sampleRate} Hz（${s.frameSamples ?? '?'} サンプル/フレーム）`
    ]
  ]
  for (const [k, v] of rows) {
    const dt = doc.createElement('dt')
    dt.textContent = k
    const dd = doc.createElement('dd')
    dd.textContent = v
    dl.append(dt, dd)
  }
  body.append(dl)

  // 無言で失敗させない。落ちたサブシステムと理由をそのまま出す
  if (problems.length > 0) {
    const box = doc.createElement('div')
    box.className = 'vc-error'
    box.textContent = problems.join('\n')
    body.append(box)
  }
}

function viewportOf(doc: Document): Point {
  const w = doc.defaultView
  return { x: w?.innerWidth ?? 1280, y: w?.innerHeight ?? 720 }
}

function place(el: HTMLElement, p: Point): void {
  el.style.left = `${p.x}px`
  el.style.top = `${p.y}px`
}

/** 端に貼り付かないよう、既定位置には余白を持たせる */
const FAB_MARGIN_PX = 16

function keepInView(el: HTMLElement, doc: Document, margin = 0): void {
  const rect = el.getBoundingClientRect()
  const vp = viewportOf(doc)
  const p = clampToViewport(
    { x: rect.left, y: rect.top },
    { x: rect.width + margin, y: rect.height + margin },
    vp
  )
  place(el, p)
}

const DRAG_THRESHOLD_PX = 4

/**
 * handle を掴んで target を動かす。しきい値を超えなければ click 扱いで onClick を呼ぶ。
 */
function makeDraggable(
  target: HTMLElement,
  handle: HTMLElement,
  doc: Document,
  onMove?: (p: Point) => void,
  onClick?: () => void
): () => void {
  let startPointer: Point | null = null
  let startPos: Point = { x: 0, y: 0 }
  let moved = false

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('button')) return
    const rect = target.getBoundingClientRect()
    startPointer = { x: e.clientX, y: e.clientY }
    startPos = { x: rect.left, y: rect.top }
    moved = false
    handle.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!startPointer) return
    const dx = e.clientX - startPointer.x
    const dy = e.clientY - startPointer.y
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    moved = true
    const rect = target.getBoundingClientRect()
    const p = clampToViewport(
      { x: startPos.x + dx, y: startPos.y + dy },
      { x: rect.width, y: rect.height },
      viewportOf(doc)
    )
    place(target, p)
  }

  const onUp = (e: PointerEvent): void => {
    if (!startPointer) return
    startPointer = null
    try {
      handle.releasePointerCapture(e.pointerId)
    } catch {
      // 既に解放済みでも構わない
    }
    if (moved) {
      const rect = target.getBoundingClientRect()
      onMove?.({ x: rect.left, y: rect.top })
    } else {
      onClick?.()
    }
  }

  handle.addEventListener('pointerdown', onDown)
  handle.addEventListener('pointermove', onPointerMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
  return () => {
    handle.removeEventListener('pointerdown', onDown)
    handle.removeEventListener('pointermove', onPointerMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }
}
