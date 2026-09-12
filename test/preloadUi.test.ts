// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  clampToViewport,
  createShell,
  DOT_COLOR,
  PORTAL_CLASS,
  ROOT_ID,
  SHELL_CSS
} from '../src/preload/shell.js'
import { portalContainer } from '../src/ui/portal.js'
import { containKeyboard, DEFAULT_HOTKEY, matchesHotkey } from '../src/preload/keyboard.js'
import { injectStyles, type DocumentLike } from '../src/preload/styles.js'
import { createApi, isVoiceCordEvent, type IpcRendererLike } from '../src/preload/api.js'
import { CH, type VoiceCordStatus } from '../src/shared/ipc.js'

const STATUS: VoiceCordStatus = {
  engine: 'searching',
  attachedPid: null,
  enginePid: null,
  sampleRate: null,
  frameSamples: null,
  discordBuild: 'canary',
  discordVersion: '1.0.1099',
  lastError: null,
  degraded: []
}

describe('clampToViewport', () => {
  it('ビューポートからはみ出さない', () => {
    expect(clampToViewport({ x: -50, y: -50 }, { x: 100, y: 100 }, { x: 800, y: 600 })).toEqual({ x: 0, y: 0 })
    expect(clampToViewport({ x: 900, y: 700 }, { x: 100, y: 100 }, { x: 800, y: 600 })).toEqual({ x: 700, y: 500 })
  })

  it('要素がビューポートより大きくても負にならない', () => {
    expect(clampToViewport({ x: 10, y: 10 }, { x: 1000, y: 900 }, { x: 800, y: 600 })).toEqual({ x: 0, y: 0 })
  })
})

describe('matchesHotkey', () => {
  const base = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'KeyB' }

  it('既定は Ctrl+Shift+B', () => {
    expect(matchesHotkey(base, DEFAULT_HOTKEY)).toBe(true)
  })

  it('修飾キーが違えば一致しない', () => {
    expect(matchesHotkey({ ...base, altKey: true }, DEFAULT_HOTKEY)).toBe(false)
    expect(matchesHotkey({ ...base, shiftKey: false }, DEFAULT_HOTKEY)).toBe(false)
    expect(matchesHotkey({ ...base, metaKey: true }, DEFAULT_HOTKEY)).toBe(false)
  })

  it('オートリピートは無視する', () => {
    expect(matchesHotkey({ ...base, repeat: true }, DEFAULT_HOTKEY)).toBe(false)
  })

  it('key ではなく code で見る（配列や IME に左右されない）', () => {
    // key が 'い' でも code が KeyB なら一致する
    expect(matchesHotkey({ ...base, code: 'KeyB' }, DEFAULT_HOTKEY)).toBe(true)
    expect(matchesHotkey({ ...base, code: 'KeyV' }, DEFAULT_HOTKEY)).toBe(false)
  })
})

describe('containKeyboard', () => {
  it('パネルが開いていて中にフォーカスがあるとき、Discord まで届かせない', () => {
    const doc = document
    const root = doc.createElement('div')
    const input = doc.createElement('input')
    root.appendChild(input)
    doc.body.appendChild(root)

    const discordHeard: string[] = []
    // Discord 側のリスナーは後から document に登録される想定
    const stop = containKeyboard(doc, { root, isOpen: () => true })
    doc.addEventListener('keydown', () => discordHeard.push('discord'), true)

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    expect(discordHeard).toEqual([])
    stop()
  })

  it('パネルが閉じているときは素通しする', () => {
    const doc = document
    const root = doc.createElement('div')
    const input = doc.createElement('input')
    root.appendChild(input)
    doc.body.appendChild(root)

    const heard: string[] = []
    const stop = containKeyboard(doc, { root, isOpen: () => false })
    doc.addEventListener('keydown', () => heard.push('discord'), true)

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    expect(heard).toEqual(['discord'])
    stop()
  })

  it('UI の外で起きたキー入力は止めない', () => {
    const doc = document
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const outside = doc.createElement('input')
    doc.body.appendChild(outside)

    const heard: string[] = []
    const stop = containKeyboard(doc, { root, isOpen: () => true })
    doc.addEventListener('keydown', () => heard.push('discord'), true)

    outside.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    expect(heard).toEqual(['discord'])
    stop()
  })

  it('解除できる', () => {
    const doc = document
    const root = doc.createElement('div')
    const input = doc.createElement('input')
    root.appendChild(input)
    doc.body.appendChild(root)

    const heard: string[] = []
    const stop = containKeyboard(doc, { root, isOpen: () => true })
    stop()
    doc.addEventListener('keydown', () => heard.push('discord'), true)
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    expect(heard).toEqual(['discord'])
  })
})

describe('injectStyles', () => {
  it('adoptedStyleSheets が使えるならそれを使い、既存を消さない', () => {
    const existing = {} as CSSStyleSheet
    const fake: DocumentLike = {
      adoptedStyleSheets: [existing],
      createElement: () => document.createElement('style'),
      head: document.head,
      documentElement: document.documentElement
    }
    const method = injectStyles(fake, '#a{color:red}')
    if (method === 'adopted') {
      expect(fake.adoptedStyleSheets).toHaveLength(2)
      expect(fake.adoptedStyleSheets![0]).toBe(existing)
    } else {
      // jsdom の版によっては CSSStyleSheet が使えない。その場合はフォールバック
      expect(method).toBe('style-element')
    }
  })

  it('adoptedStyleSheets が無ければ <style> を足す', () => {
    const appended: Node[] = []
    const fake: DocumentLike = {
      createElement: (t) => document.createElement(t),
      head: { appendChild: (n) => void appended.push(n) },
      documentElement: document.documentElement
    }
    expect(injectStyles(fake, '#a{color:red}')).toBe('style-element')
    expect((appended[0] as HTMLStyleElement).textContent).toBe('#a{color:red}')
  })
})

describe('createShell', () => {
  it('FAB とパネルを作り、既定では閉じている', () => {
    const shell = createShell({ doc: document })
    expect(shell.root.id).toBe(ROOT_ID)
    expect(shell.root.querySelector('.vc-fab')).not.toBeNull()
    expect(shell.isOpen()).toBe(false)
    shell.destroy()
  })

  it('開閉できる', () => {
    const shell = createShell({ doc: document })
    document.body.appendChild(shell.root)
    shell.open()
    expect(shell.isOpen()).toBe(true)
    shell.toggle()
    expect(shell.isOpen()).toBe(false)
    shell.destroy()
  })

  it('エンジンの状態が FAB の色に出る（可視化 2）', () => {
    const shell = createShell({ doc: document })
    const dot = shell.root.querySelector<HTMLElement>('.vc-dot')!
    shell.setStatus({ ...STATUS, engine: 'attached' })
    expect(dot.style.background).toContain('59, 165, 93') // DOT_COLOR.attached
    shell.setStatus({ ...STATUS, engine: 'failed' })
    expect(dot.style.background).toContain('237, 66, 69')
    shell.destroy()
  })

  it('落ちたサブシステムの理由をパネルに出す（無言で失敗させない）', () => {
    const shell = createShell({ doc: document })
    shell.setStatus({
      ...STATUS,
      engine: 'failed',
      lastError: 'engine: frida のロードに失敗',
      degraded: [{ name: 'engine', error: 'frida のロードに失敗' }]
    })
    const box = shell.root.querySelector('.vc-error')
    expect(box?.textContent).toContain('frida のロードに失敗')
    shell.destroy()
  })

  it('React のマウント先は状態表示と別の要素にする', () => {
    // setStatus は replaceChildren で書き直すので、同じ要素を React にも渡すと
    // 状態が更新されるたびに UI が消える
    const shell = createShell({ doc: document })
    const marker = document.createElement('span')
    shell.body.appendChild(marker)
    shell.setStatus(STATUS)
    expect(shell.body.contains(marker)).toBe(true)
    expect(shell.root.querySelector('.vc-kv')).not.toBeNull()
    shell.destroy()
  })

  it('Radix の Portal 用のコンテナを #vc-root 配下に持つ', () => {
    const shell = createShell({ doc: document })
    document.body.appendChild(shell.root)
    expect(shell.portal.className).toBe(PORTAL_CLASS)
    expect(shell.root.contains(shell.portal)).toBe(true)
    // パネルより後ろ = ダイアログがパネルの下に潜らない
    const kids = [...shell.root.children]
    expect(kids.indexOf(shell.portal)).toBeGreaterThan(
      kids.indexOf(shell.root.querySelector('.vc-panel')!)
    )
    shell.destroy()
  })

  it('destroy で DOM から消える', () => {
    const shell = createShell({ doc: document })
    document.body.appendChild(shell.root)
    expect(document.getElementById(ROOT_ID)).not.toBeNull()
    shell.destroy()
    expect(document.getElementById(ROOT_ID)).toBeNull()
  })

  it('スタイルはすべて #vc-root 配下に閉じている（Discord へ漏らさない）', () => {
    // ルールごとに分け、宣言ブロックを落としてセレクタだけを取り出す。
    // カンマ区切りの並びも 1 つずつ見る
    const selectors = SHELL_CSS.split('}')
      .map((rule) => rule.split('{')[0] ?? '')
      .flatMap((sel) => sel.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    expect(selectors.length).toBeGreaterThan(0)
    const leaked = selectors.filter((s) => !s.startsWith(`#${ROOT_ID}`))
    // 1 つでも漏れていると Discord 側のスタイルを壊しうる
    expect(leaked).toEqual([])
  })

  it('閉じているときクリックを吸わない', () => {
    expect(SHELL_CSS).toContain('pointer-events: none')
    expect(SHELL_CSS).toContain('pointer-events: auto')
  })
})

describe('portalContainer', () => {
  it('shell がまだ無ければ undefined を返す（Radix は既定の body へ落ちる）', () => {
    document.getElementById(ROOT_ID)?.remove()
    expect(portalContainer()).toBeUndefined()
  })

  it('マウント後は #vc-root 配下のコンテナを返す', () => {
    const shell = createShell({ doc: document })
    document.body.appendChild(shell.root)
    expect(portalContainer()).toBe(shell.portal)
    shell.destroy()
  })
})

describe('createApi', () => {
  function fakeIpc(): IpcRendererLike & {
    listeners: Array<(e: unknown, ...a: unknown[]) => void>
    /** main からのプッシュを模す。createApi は内部にもリスナーを持つので全員に配る */
    push: (payload: unknown) => void
  } {
    const listeners: Array<(e: unknown, ...a: unknown[]) => void> = []
    return {
      listeners,
      push: (payload) => {
        for (const l of [...listeners]) l(null, payload)
      },
      invoke: vi.fn(async (ch: string) => (ch === CH.getStatus || ch === CH.subscribe ? STATUS : undefined)),
      on: (_ch, l) => void listeners.push(l),
      removeListener: (_ch, l) => {
        const i = listeners.indexOf(l)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
  }

  it('subscribe は現在の状態を返す', async () => {
    const api = createApi(fakeIpc())
    await expect(api.subscribe()).resolves.toEqual(STATUS)
  })

  it('イベントを購読・解除できる', () => {
    const ipc = fakeIpc()
    const api = createApi(ipc)
    const seen: unknown[] = []
    const before = ipc.listeners.length
    const off = api.onEvent((e) => seen.push(e))
    ipc.push({ ev: 'status', status: STATUS })
    expect(seen).toHaveLength(1)
    off()
    expect(ipc.listeners).toHaveLength(before)
  })

  it('形の合わないペイロードは UI に渡さない', () => {
    const ipc = fakeIpc()
    const api = createApi(ipc)
    const seen: unknown[] = []
    api.onEvent((e) => seen.push(e))
    ipc.push({ ev: 'nope' })
    ipc.push(null)
    ipc.push('string')
    expect(seen).toHaveLength(0)
  })
})

describe('isVoiceCordEvent', () => {
  it('status と log だけを通す', () => {
    expect(isVoiceCordEvent({ ev: 'status', status: STATUS })).toBe(true)
    expect(isVoiceCordEvent({ ev: 'log', level: 'info', message: 'x' })).toBe(true)
    expect(isVoiceCordEvent({ ev: 'other' })).toBe(false)
    expect(isVoiceCordEvent(undefined)).toBe(false)
  })
})

describe('DOT_COLOR', () => {
  it('4 状態すべてに色がある', () => {
    expect(Object.keys(DOT_COLOR).sort()).toEqual(['attached', 'failed', 'searching', 'starting'])
  })
})

describe('状態表示の出し分け', () => {
  it('正常なときは何も出さない（サウンドボードの領域を食わない）', () => {
    const shell = createShell({ doc: document })
    shell.setStatus({ ...STATUS, engine: 'attached', attachedPid: 30736 })
    const status = shell.root.querySelector<HTMLElement>('.vc-status')!
    expect(status.hidden).toBe(true)
    shell.destroy()
  })

  it('attach 前は状態を出す', () => {
    const shell = createShell({ doc: document })
    shell.setStatus({ ...STATUS, engine: 'searching' })
    const status = shell.root.querySelector<HTMLElement>('.vc-status')!
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('canary')
    shell.destroy()
  })

  it('attach 済みでも問題があれば出す', () => {
    const shell = createShell({ doc: document })
    shell.setStatus({
      ...STATUS,
      engine: 'attached',
      degraded: [{ name: 'state', error: 'state.json を書けません' }]
    })
    const status = shell.root.querySelector<HTMLElement>('.vc-status')!
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('state.json を書けません')
    shell.destroy()
  })
})

describe('FAB の既定位置', () => {
  it('settle で右下に寄る（Discord のユーザーパネルを塞がない）', () => {
    // 左下には Discord のマイク・スピーカー・設定ボタンがある
    const shell = createShell({ doc: document })
    document.body.appendChild(shell.root)
    const fab = shell.root.querySelector<HTMLElement>('.vc-fab')!
    // jsdom では実寸が 0 なので、測れたことにして詰める
    fab.getBoundingClientRect = () =>
      ({ left: 9999, top: 9999, width: 100, height: 30 }) as DOMRect
    shell.settle()
    // 右下から余白ぶん内側に入る
    expect(parseFloat(fab.style.left)).toBeLessThan(window.innerWidth)
    expect(parseFloat(fab.style.left)).toBeGreaterThan(0)
    expect(parseFloat(fab.style.top)).toBeLessThan(window.innerHeight)
    shell.destroy()
  })

  it('位置を明示したときは settle で動かさない', () => {
    const shell = createShell({ doc: document, fabPos: { x: 10, y: 20 } })
    document.body.appendChild(shell.root)
    const fab = shell.root.querySelector<HTMLElement>('.vc-fab')!
    shell.settle()
    expect(fab.style.left).toBe('10px')
    expect(fab.style.top).toBe('20px')
    shell.destroy()
  })
})
