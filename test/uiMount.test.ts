// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../src/ui/App.js'
import { useStore } from '../src/ui/store.js'
import { usePopout } from '../src/ui/popout.js'
import { voiceMatchDb } from '../src/ui/lib/calibration.js'
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

const okStatus = {
  engine: 'attached' as const,
  attachedPid: 1234,
  enginePid: 5678,
  sampleRate: 48000,
  frameSamples: 480,
  discordBuild: 'canary',
  discordVersion: '1.0.1169',
  lastError: null,
  degraded: []
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...shell.portal.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text)
  )
}

// ポップアウトを開いて歯車から設定画面に入る
async function openSettings(state: Partial<ReturnType<typeof usePopout.getState>>): Promise<void> {
  await act(async () => {
    usePopout.setState({ anchor, ...state })
    usePopout.getState().setOpen(true)
  })
  await act(async () => {
    shell.portal.querySelector<HTMLButtonElement>('button[aria-label="VoiceCord の設定"]')!.click()
  })
}

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

  it('tier 2 では警告せず、tier 3 では警告する', async () => {
    const info = {
      mode: 'graft' as const,
      tier: 2 as const,
      inserts: 1,
      tripped: false,
      harvest: 'ok',
      fabReason: null
    }
    await act(async () => {
      usePopout.setState({ anchor, anchorInfo: info, status: null })
      usePopout.getState().setOpen(true)
    })
    await act(async () => {
      shell.portal.querySelector<HTMLButtonElement>('button[aria-label="VoiceCord の設定"]')!.click()
    })
    expect(shell.portal.textContent).not.toContain('予備の方法で見つけています')

    // 警告は「接続状態」の詳細に入るので、開いた状態で確かめる
    await act(async () => {
      findButton('詳細')!.click()
    })
    expect(shell.portal.textContent).not.toContain('予備の方法で見つけています')
    await act(async () => {
      usePopout.setState({ anchorInfo: { ...info, tier: 3 } })
    })
    expect(shell.portal.textContent).toContain('予備の方法で見つけています')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('設定画面は1ページの項目リストで、タブを持たず、使う頻度の高い順に並ぶ', async () => {
    await openSettings({ status: null, anchorInfo: null })
    const pop = shell.portal.querySelector('.vc-popout')!
    expect([...pop.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      '音量',
      'モニター',
      '入場サウンド',
      'サウンドフォルダ',
      '接続状態'
    ])
    expect(pop.querySelector('[role="tablist"]')).toBeNull()
    expect(pop.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u)
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('平常時は診断を畳んでおき、「詳細」で開閉する', async () => {
    await openSettings({ status: { ...okStatus }, anchorInfo: null })
    const toggle = findButton('詳細')!
    // aria-controls の指す先は畳んでいても存在し、hidden で隠れている
    const panel = shell.portal.querySelector<HTMLElement>(`#${toggle.getAttribute('aria-controls')}`)!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('エンジン PID')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('開いた後に不調が出たり増えたりしたら、診断を開く', async () => {
    await openSettings({ status: { ...okStatus }, anchorInfo: null })
    const toggle = findButton('詳細')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      usePopout.setState({ status: { ...okStatus, lastError: 'frida を読み込めませんでした' } })
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // 不調が残ったまま畳んでも、別の不調が増えたら開き直す
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      usePopout.setState({
        status: {
          ...okStatus,
          lastError: 'frida を読み込めませんでした',
          degraded: [{ name: 'sidetone', error: '出力デバイスを開けません' }]
        }
      })
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // 内容が変わらなければ、畳んだままにする
    await act(async () => {
      toggle.click()
    })
    await act(async () => {
      usePopout.setState({
        status: {
          ...okStatus,
          lastError: 'frida を読み込めませんでした',
          degraded: [{ name: 'sidetone', error: '出力デバイスを開けません' }]
        }
      })
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('fabReason や tier 3 の警告が出たら、診断を開く', async () => {
    const info = {
      mode: 'graft' as const,
      tier: 1 as const,
      inserts: 1,
      tripped: false,
      harvest: 'ok',
      fabReason: null
    }
    await openSettings({ status: null, anchorInfo: info })
    const toggle = findButton('詳細')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      usePopout.setState({ anchorInfo: { ...info, mode: 'fab', fabReason: 'ボタンの置き場所が見つかりません' } })
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })

    await openSettings({ status: null, anchorInfo: info })
    const toggle2 = findButton('詳細')!
    expect(toggle2.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      usePopout.setState({ anchorInfo: { ...info, tier: 3 } })
    })
    expect(toggle2.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('音量: 未校正なら「音量を調整」で音量調整が開き、声とずれている時だけ「声と同じ大きさに戻す」が出る', async () => {
    const original = useStore.getState().settings
    const hasRestoreRow = (): boolean => shell.portal.textContent?.includes('声と同じ大きさに戻す') ?? false
    try {
      await act(async () => {
        useStore.setState({ settings: { ...original, calibration: null } })
      })
      await openSettings({ status: null, anchorInfo: null })
      expect(hasRestoreRow()).toBe(false)
      await act(async () => {
        findButton('音量を調整')!.click()
      })
      expect(useStore.getState().levelOpen).toBe(true)
      await act(async () => {
        useStore.getState().setLevelOpen(false)
      })

      const calibration = { at: 0, voiceRms: 0.1, voicePeak: 0.5, activeRatio: 0.8, targetDb: 0 }
      const matchDb = voiceMatchDb(calibration.voiceRms, original.normalizeRefDbfs)!
      // 声とぴったり一致(差 ±0.0 dB)なら戻す行は出ない
      await act(async () => {
        useStore.setState({ settings: { ...original, calibration, master: 10 ** (matchDb / 20) } })
      })
      expect(findButton('音量調整を開く')).not.toBeUndefined()
      expect(hasRestoreRow()).toBe(false)
      // 6 dB ずらすと出る
      await act(async () => {
        useStore.setState({ settings: { ...original, calibration, master: 10 ** ((matchDb + 6) / 20) } })
      })
      expect(hasRestoreRow()).toBe(true)
      expect(
        shell.portal.querySelector('button[aria-label="声と同じ大きさに戻す"]')
      ).not.toBeNull()
    } finally {
      await act(async () => {
        useStore.setState({ settings: original, levelOpen: false })
        usePopout.getState().setOpen(false)
      })
    }
  })

  it('モニター: スイッチ、出力デバイス、音量スライダーがある', async () => {
    await openSettings({ status: null, anchorInfo: null })
    const pop = shell.portal.querySelector('.vc-popout')!
    expect(pop.querySelector('button[role="switch"][aria-label="自分の端末でも聴く"]')).not.toBeNull()
    expect(pop.querySelector('[aria-label="モニター出力デバイス"]')).not.toBeNull()
    expect(pop.querySelector('[role="slider"][aria-label="モニター音量"]')).not.toBeNull()
    // 短い文言のボタンには、何の操作か分かる名前を付ける
    expect(pop.querySelector('button[aria-label="サウンドフォルダを選ぶ"]')).not.toBeNull()
    expect(pop.querySelector('button[aria-label="サウンドフォルダを再読込"]')).not.toBeNull()
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('不調があるときは、診断を最初から開いておく（不具合を隠さない）', async () => {
    await openSettings({
      status: { ...okStatus, engine: 'failed', lastError: 'frida を読み込めませんでした' },
      anchorInfo: null
    })
    expect(findButton('詳細')!.getAttribute('aria-expanded')).toBe('true')
    expect(shell.portal.textContent).toContain('エンジン PID')
    expect(shell.portal.textContent).toContain('frida を読み込めませんでした')
    await act(async () => {
      usePopout.getState().setOpen(false)
    })
  })

  it('入場サウンドの行でオンオフでき、「設定」でダイアログが開く', async () => {
    const before = useStore.getState().settings.entrySoundEnabled
    const beforeSrc = useStore.getState().settings.entrySoundSrcId
    try {
      await act(async () => {
        useStore.setState({ settings: { ...useStore.getState().settings, entrySoundSrcId: '' } })
      })
      await openSettings({ status: null, anchorInfo: null })
      // 文言は入場サウンドのダイアログと揃える
      expect(shell.portal.textContent).toContain('サウンドが未選択のため鳴りません')
      const sw = shell.portal.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="VC に入ったら自動で鳴らす"]'
      )!
      expect(sw).not.toBeNull()
      await act(async () => {
        sw.click()
      })
      expect(useStore.getState().settings.entrySoundEnabled).toBe(!before)
      await act(async () => {
        shell.portal.querySelector<HTMLButtonElement>('button[aria-label="入場サウンドの設定を開く"]')!.click()
      })
      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog!.textContent).toContain('入場サウンド')
      expect(usePopout.getState().open).toBe(true)
    } finally {
      await act(async () => {
        useStore.getState().patchSettings({ entrySoundEnabled: before })
        useStore.setState({ settings: { ...useStore.getState().settings, entrySoundSrcId: beforeSrc } })
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await act(async () => {
        usePopout.getState().setOpen(false)
      })
    }
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

  it('フッターの「揃える」は全停止の左にあり、全件調整済みでも押せ、音源が無ければ押せない', async () => {
    const normalizeAll = vi.fn(async () => {})
    const original = {
      normalizeAll: useStore.getState().normalizeAll,
      sounds: useStore.getState().sounds,
      sourceVolumes: useStore.getState().sourceVolumes
    }
    const findButton = (text: string): HTMLButtonElement | undefined =>
      [...shell.portal.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text)
      )
    try {
      const sounds = useStore.getState().sounds
      expect(sounds.length).toBeGreaterThan(0)
      // 全件に音量が保存済みでも押せる
      await act(async () => {
        useStore.setState({
          normalizeAll,
          sourceVolumes: Object.fromEntries(sounds.map((s) => [s.id, 1]))
        })
        usePopout.setState({ anchor, status: null })
        usePopout.getState().setOpen(true)
      })
      const align = findButton('揃える')!
      const stop = findButton('全停止')!
      expect(align).not.toBeUndefined()
      expect(align.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(align.disabled).toBe(false)
      expect(align.getAttribute('aria-label')).toBe('すべての音源の音量を揃える')
      expect(align.getAttribute('title')).toBe(align.getAttribute('aria-label'))
      await act(async () => {
        align.click()
      })
      expect(normalizeAll).toHaveBeenCalledTimes(1)

      // 実行中は進捗を出して押せない
      await act(async () => {
        useStore.setState({ normalizeJob: { done: 3, total: 12 } })
      })
      expect(align.disabled).toBe(true)
      expect(align.textContent).toContain('3/12')

      // 音源が無ければ押せない
      await act(async () => {
        useStore.setState({ normalizeJob: null, sounds: [] })
      })
      expect(align.disabled).toBe(true)
      expect(align.getAttribute('title')).toBe('音源がありません')
      expect(align.parentElement?.getAttribute('title')).toBe('音源がありません')
    } finally {
      await act(async () => {
        useStore.setState({ ...original, normalizeJob: null })
        usePopout.getState().setOpen(false)
      })
    }
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
