import type { EngineState, VoiceCordStatus } from '../shared/ipc.js'

/**
 * Discord の画面に生やす器。
 *
 * Discord の DOM には接ぎ木しない。クラス名はビルドごとにハッシュが変わるうえ、
 * React の再レンダリングで我々のノードが外される。document.body 直下に
 * フローティングで置けば Discord の内部構造から完全に独立できる。
 *
 * FAB はエンジンの状態から独立して無条件に出す。パッチが当たっていれば必ず出て、
 * 外れていれば何も出ない ＝ FAB の在／不在がそのままパッチ状態になる（可視化 1）。
 * エンジンが死んでいても FAB は出て、色で異常を示し、開けば理由が読める（可視化 2）。
 */

export const ROOT_ID = 'vc-root'

/** エンジンの状態と FAB の色の対応（可視化 2） */
export const DOT_COLOR: Record<EngineState, string> = {
  starting: '#8a8f98',
  searching: '#e8a33d',
  attached: '#3ba55d',
  failed: '#ed4245'
}

export const DOT_LABEL: Record<EngineState, string> = {
  starting: '起動中',
  searching: 'エンジン生存・音声プロセス未検出',
  attached: 'アタッチ済み',
  failed: 'エンジンが動いていません'
}

/**
 * 器のスタイル。Tailwind の出力（M1-e）とは別に、器そのものだけを賄う。
 * すべて #vc-root 配下に閉じ込め、Discord 側へ漏らさない。
 */
export const SHELL_CSS = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  /* 閉じているときにクリックを吸わない。中身だけが受け取る */
  pointer-events: none;
  color-scheme: dark;
}
#${ROOT_ID} .vc-fab,
#${ROOT_ID} .vc-panel {
  pointer-events: auto;
}
#${ROOT_ID} .vc-fab {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #1e1f22;
  color: #dbdee1;
  font: 500 13px/1 system-ui, sans-serif;
  cursor: grab;
  user-select: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
#${ROOT_ID} .vc-fab:active { cursor: grabbing; }
#${ROOT_ID} .vc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${DOT_COLOR.starting};
  flex: none;
}
#${ROOT_ID} .vc-panel {
  position: absolute;
  display: none;
  flex-direction: column;
  min-width: 360px;
  min-height: 240px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #313338;
  color: #dbdee1;
  font: 400 14px/1.5 system-ui, sans-serif;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  resize: both;
}
#${ROOT_ID} .vc-panel[data-open="true"] { display: flex; }
#${ROOT_ID} .vc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #2b2d31;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  cursor: grab;
  user-select: none;
  font-weight: 600;
}
#${ROOT_ID} .vc-head:active { cursor: grabbing; }
#${ROOT_ID} .vc-spacer { flex: 1; }
#${ROOT_ID} .vc-close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
#${ROOT_ID} .vc-close:hover { background: rgba(255, 255, 255, 0.08); }
#${ROOT_ID} .vc-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
#${ROOT_ID} .vc-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 13px;
}
#${ROOT_ID} .vc-kv dt { color: #949ba4; }
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
  /** M1-e ではここに React をマウントする */
  body: HTMLElement
  isOpen: () => boolean
  open: () => void
  close: () => void
  toggle: () => void
  setStatus: (s: VoiceCordStatus) => void
  destroy: () => void
}

export interface ShellOptions {
  doc: Document
  /** FAB の初期位置。無ければ左下 */
  fabPos?: Point
  /** パネルの初期位置 */
  panelPos?: Point
  onMove?: (what: 'fab' | 'panel', p: Point) => void
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

  const panel = doc.createElement('div')
  panel.className = 'vc-panel'
  panel.dataset['open'] = 'false'
  const head = doc.createElement('div')
  head.className = 'vc-head'
  const title = doc.createElement('span')
  title.textContent = 'VoiceCord'
  const spacer = doc.createElement('span')
  spacer.className = 'vc-spacer'
  const close = doc.createElement('button')
  close.className = 'vc-close'
  close.textContent = '×'
  close.setAttribute('aria-label', '閉じる')
  head.append(title, spacer, close)
  const body = doc.createElement('div')
  body.className = 'vc-body'
  panel.append(head, body)

  root.append(fab, panel)

  const fabPos = opts.fabPos ?? { x: 16, y: viewportOf(doc).y - 64 }
  const panelPos = opts.panelPos ?? { x: 80, y: 80 }
  place(fab, fabPos)
  place(panel, panelPos)

  const setOpen = (open: boolean): void => {
    panel.dataset['open'] = String(open)
    if (open) keepInView(panel, doc)
  }
  const isOpen = (): boolean => panel.dataset['open'] === 'true'

  // ドラッグ移動。クリックとドラッグを取り違えないよう、
  // しきい値を超えて初めてドラッグ扱いにする
  const stopFabDrag = makeDraggable(fab, fab, doc, (p) => opts.onMove?.('fab', p), () => {
    setOpen(!isOpen())
  })
  const stopPanelDrag = makeDraggable(panel, head, doc, (p) => opts.onMove?.('panel', p))

  close.addEventListener('click', () => setOpen(false))

  const setStatus = (s: VoiceCordStatus): void => {
    dot.style.background = DOT_COLOR[s.engine]
    const label = DOT_LABEL[s.engine]
    fab.title = `VoiceCord — ${label}\n${s.discordBuild} ${s.discordVersion}` +
      (s.attachedPid !== null ? `\naudio PID ${s.attachedPid}` : '')
    renderBody(doc, body, s)
  }

  return {
    root,
    body,
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    setStatus,
    destroy: () => {
      stopFabDrag()
      stopPanelDrag()
      root.remove()
    }
  }
}

function renderBody(doc: Document, body: HTMLElement, s: VoiceCordStatus): void {
  body.replaceChildren()
  const dl = doc.createElement('dl')
  dl.className = 'vc-kv'
  const rows: Array<[string, string]> = [
    ['状態', DOT_LABEL[s.engine]],
    ['ビルド', `${s.discordBuild} ${s.discordVersion}`],
    ['音声プロセス', s.attachedPid === null ? '未検出' : String(s.attachedPid)]
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
  const problems = [
    ...(s.lastError ? [s.lastError] : []),
    ...s.degraded.map((d) => `${d.name}: ${d.error}`)
  ]
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

function keepInView(el: HTMLElement, doc: Document): void {
  const rect = el.getBoundingClientRect()
  const p = clampToViewport(
    { x: rect.left, y: rect.top },
    { x: rect.width, y: rect.height },
    viewportOf(doc)
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
    // リサイズハンドルや閉じるボタンの上では掴まない
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
