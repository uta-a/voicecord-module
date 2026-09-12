// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it } from 'vitest'
import App from '../src/ui/App.js'
import { useStore } from '../src/ui/store.js'
import { createShell, type Shell } from '../src/preload/shell.js'

/**
 * 移植した UI が器の中で立ち上がることの検査。
 *
 * ここが緑なら「preload が createShell → React の順で組み立てれば、エンジンが
 * 無くても画面が端まで出る」ことになる。型チェックとバンドルだけでは、
 * Portal の行き先や store の初期化のような実行時の配線は分からない。
 */

class NoopResizeObserver implements ResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let shell: Shell

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Radix の Slider / ScrollArea が使う。jsdom には無い
  globalThis.ResizeObserver = NoopResizeObserver

  shell = createShell({ doc: document })
  document.body.appendChild(shell.root)
  await act(async () => {
    createRoot(shell.body).render(createElement(App))
  })
  // モックの attach が 'vc' と 'gateInfo' を返すまで待つ
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600))
  })
})

describe('UI のマウント', () => {
  it('モックのエンジンだけで端まで描画できる', () => {
    expect(shell.body.textContent).toContain('VOICECORD')
    const st = useStore.getState()
    expect(st.ready).toBe(true)
    // 未接続だと再生まわりが全部無効表示になり、描画の確認にならない
    expect(st.connection).toBe('connected')
    expect(st.sounds.length).toBeGreaterThan(0)
  })

  it('エンジンの状態表示を書き換えても UI が消えない', () => {
    shell.setStatus({
      engine: 'attached',
      attachedPid: 4242,
      enginePid: null,
      sampleRate: null,
      frameSamples: null,
      discordBuild: 'canary',
      discordVersion: '1.0.1158',
      lastError: null,
      degraded: []
    })
    expect(shell.body.textContent).toContain('VOICECORD')
  })

  it('Radix の Portal が #vc-root 配下に出る（document.body 直下ではない）', async () => {
    await act(async () => {
      useStore.getState().setLevelOpen(true)
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // ここが外れると、スコープした Tailwind が 1 つも当たらず素の HTML になる
    expect(shell.portal.contains(dialog)).toBe(true)
    await act(async () => {
      useStore.getState().setLevelOpen(false)
    })
  })
})
