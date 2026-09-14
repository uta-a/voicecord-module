// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../src/ui/App.js'
import { useStore } from '../src/ui/store.js'
import { usePopout } from '../src/ui/popout.js'
import { createShell, type Shell } from '../src/preload/shell.js'

/**
 * UI が器の中で立ち上がることの検査。
 *
 * M4.5 で UI は「接ぎ木したボタンにアンカーするポップアウト」になった。
 * ここが緑なら「preload が createShell → React の順で組み立て、アンカーを渡して開けば、
 * エンジンが無くてもサウンドボードが端まで出る」ことになる。
 */

class NoopResizeObserver implements ResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let shell: Shell
let anchor: HTMLElement

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Radix の Slider / ScrollArea / Popper が使う。jsdom には無い
  globalThis.ResizeObserver = NoopResizeObserver

  shell = createShell({ doc: document })
  document.body.appendChild(shell.root)
  anchor = document.createElement('button')
  document.body.appendChild(anchor)
  await act(async () => {
    createRoot(shell.body).render(createElement(App))
  })
  // モックの attach が 'vc' と 'gateInfo' を返すまで待つ
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600))
  })
})

describe('UI のマウント', () => {
  it('閉じているときは何も描画しない（Discord の画面を覆わない）', () => {
    expect(shell.portal.querySelector('.vc-popout')).toBeNull()
    expect(useStore.getState().ready).toBe(true)
  })

  it('アンカーが無ければ開かない', async () => {
    await act(async () => {
      usePopout.setState({ anchor: null })
      usePopout.getState().setOpen(true)
    })
    expect(shell.portal.querySelector('.vc-popout')).toBeNull()
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('アンカーを渡して開くと、サウンドボードが #vc-root 配下に出る', async () => {
    await act(async () => {
      usePopout.setState({ anchor })
      usePopout.getState().setOpen(true)
    })
    const pop = shell.portal.querySelector('.vc-popout')
    expect(pop).not.toBeNull()
    // ここが外れると、スコープした Tailwind が 1 つも当たらず素の HTML になる
    expect(shell.portal.contains(pop)).toBe(true)
    expect(pop!.querySelector('input[aria-label="サウンドを検索"]')).not.toBeNull()
    const st = useStore.getState()
    expect(st.connection).toBe('connected')
    expect(pop!.querySelectorAll('.vc-tile')).toHaveLength(st.sounds.length)
    // 絵文字を UI に使わない
    expect(pop!.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('歯車から設定画面に入り、閉じると次はサウンドの一覧から始まる', async () => {
    const gear = shell.portal.querySelector<HTMLButtonElement>('button[aria-label="VoiceCord の設定"]')!
    await act(async () => {
      gear.click()
    })
    expect(shell.portal.textContent).toContain('VoiceCord の設定')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
    expect(usePopout.getState().view).toBe('main')
  })

  it('状態を渡すと不調が帯に出る', async () => {
    await act(async () => {
      usePopout.setState({
        anchor,
        status: {
          engine: 'failed',
          attachedPid: null,
          enginePid: null,
          sampleRate: null,
          frameSamples: null,
          discordBuild: 'canary',
          discordVersion: '1.0.1169',
          lastError: 'frida を読み込めませんでした',
          degraded: []
        }
      })
      usePopout.getState().setOpen(true)
    })
    expect(shell.portal.textContent).toContain('frida を読み込めませんでした')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('ポップアウトから開いたダイアログは、ポップアウトを勝手に閉じない', async () => {
    await act(async () => {
      usePopout.setState({ anchor, status: null })
      usePopout.getState().setOpen(true)
    })
    const fader = shell.portal.querySelector<HTMLButtonElement>('button[aria-label="音量調整を開く"]')!
    await act(async () => {
      fader.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(useStore.getState().levelOpen).toBe(true)
    expect(usePopout.getState().open).toBe(true)
    expect(shell.portal.querySelector('.vc-popout')).not.toBeNull()
    await act(async () => {
      useStore.getState().setLevelOpen(false)
      usePopout.getState().setOpen(false)
    })
  })

  it('合成クリックでは再生しない（ページ側のスクリプトに VC へ音を流させない）', async () => {
    const play = vi.fn(async () => {})
    const stopAll = vi.fn()
    const original = { play: useStore.getState().play, stopAll: useStore.getState().stopAll }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await act(async () => {
        useStore.setState({ play, stopAll })
        usePopout.setState({ anchor, status: null })
        usePopout.getState().setOpen(true)
      })
      const tile = shell.portal.querySelector<HTMLButtonElement>('button[aria-label$="をプレイする"]')!
      expect(tile).not.toBeNull()
      // jsdom の click() は isTrusted === false（ページ側の el.click() と同じ）
      await act(async () => {
        tile.click()
      })
      expect(play).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)

      // 止める操作は合成クリックでも効かせる（止められないほうが危ない）
      const stop = [...shell.portal.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.includes('全停止')
      )!
      await act(async () => {
        stop.click()
      })
      expect(stopAll).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        useStore.setState(original)
        usePopout.getState().setOpen(false)
      })
      warn.mockRestore()
    }
  })

  it('Radix のダイアログも #vc-root 配下に出る（document.body 直下ではない）', async () => {
    await act(async () => {
      useStore.getState().setLevelOpen(true)
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(shell.portal.contains(dialog)).toBe(true)
    await act(async () => {
      useStore.getState().setLevelOpen(false)
    })
  })
})
