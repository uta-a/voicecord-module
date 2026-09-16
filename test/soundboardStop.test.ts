// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findSoundboardAnchor, GRAFT_ATTR } from '../src/preload/anchor.js'
import { createGraft, refreshGraftButton } from '../src/preload/graft.js'
import { findLockedSound } from '../src/preload/lockedSounds.js'
import {
  buildSoundboardStopButton,
  findSoundboardVolumeButton,
  SOUNDBOARD_STOP_LABEL,
  SOUNDBOARD_STOP_MARK,
  wireSoundboardStopButton
} from '../src/preload/soundboardStop.js'

/**
 * 純正サウンドボードのヘッダーに置く停止ボタン。
 * fixture は Canary 1.0.1175 の実 DOM（検索欄と svg の中身は省いた）。
 */

const HEADER = `<div class="header__0856d"><div class="wrapper__0d1ef"><input aria-label="検索"></div><div class="settingsClickArea__61424" role="button" aria-label="サウンドボードの音量" tabindex="0"><svg class="settingsIcon__61424" width="24" height="24"></svg></div></div>`
const SOUND = `<ul class="soundRow__61424"><li class="soundButtonWrapper__9be63"><div class="soundButton__9be63"></div></li></ul>`
const PICKER = `<div class="picker__09f65" role="dialog">${HEADER}${SOUND}</div>`

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('findSoundboardVolumeButton', () => {
  it('純正サウンドボードの音量アイコンを返す', () => {
    document.body.innerHTML = PICKER
    expect(findSoundboardVolumeButton(document)?.anchor).toBe($('[class*="settingsClickArea"]'))
  })

  it('サウンドボタンの無いダイアログ、#vc-root の中、ダイアログが無いときは null', () => {
    document.body.innerHTML = `<div role="dialog">${HEADER}</div><section>${HEADER}${SOUND}</section><div id="vc-root">${PICKER}</div>`
    expect(findSoundboardVolumeButton(document, $('#vc-root'))).toBeNull()
  })

  it('自分の停止ボタンを音量アイコンと取り違えない', () => {
    document.body.innerHTML = PICKER
    const volume = $('[class*="settingsClickArea"]')
    volume.before(buildSoundboardStopButton(document, volume))
    expect(findSoundboardVolumeButton(document)?.anchor).toBe(volume)
  })
})

describe('buildSoundboardStopButton', () => {
  it('音量アイコンの見た目を写し、印とラベルを付ける', () => {
    document.body.innerHTML = PICKER
    const b = buildSoundboardStopButton(document, $('[class*="settingsClickArea"]'))
    expect(b.className).toBe('settingsClickArea__61424')
    expect(b.getAttribute('role')).toBe('button')
    expect(b.getAttribute('tabindex')).toBe('0')
    expect(b.getAttribute('aria-label')).toBe(SOUNDBOARD_STOP_LABEL)
    expect(b.getAttribute(GRAFT_ATTR)).toBe(SOUNDBOARD_STOP_MARK)
    const svg = b.querySelector('svg')!
    expect(svg.getAttribute('class')).toBe('settingsIcon__61424')
    expect(svg.getAttribute('width')).toBe('24')
  })
})

describe('createGraft と組み合わせる', () => {
  const start = (): ReturnType<typeof createGraft> => {
    const g = createGraft({
      doc: document,
      find: () => findSoundboardVolumeButton(document),
      build: (v) => buildSoundboardStopButton(document, v),
      inline: () => true,
      refresh: refreshGraftButton,
      onChange: () => {},
      now: () => 0,
      schedule: (fn) => fn()
    })
    g.start()
    return g
  }

  it('音量アイコンの直後に 1 つだけ入り、開き直しても 1 つ', () => {
    document.body.innerHTML = PICKER
    const g = start()
    const stop = (): Element[] => Array.from(document.querySelectorAll(`[${GRAFT_ATTR}="${SOUNDBOARD_STOP_MARK}"]`))
    expect(stop()).toHaveLength(1)
    expect($('[class*="settingsClickArea"]').nextElementSibling).toBe(stop()[0])

    // 閉じる → 開き直す
    document.body.innerHTML = ''
    g.sync(true)
    expect(stop()).toHaveLength(0)
    document.body.innerHTML = PICKER
    g.sync(true)
    expect(stop()).toHaveLength(1)
    expect($('[class*="settingsClickArea"]').nextElementSibling).toBe(stop()[0])
    g.stop()
  })
})

describe('wireSoundboardStopButton', () => {
  const setup = () => {
    document.body.innerHTML = PICKER
    const volume = $('[class*="settingsClickArea"]')
    const deps = { stopAll: vi.fn(), showTip: vi.fn(), hideTip: vi.fn() }
    const b = wireSoundboardStopButton(buildSoundboardStopButton(document, volume), deps)
    volume.after(b)
    // 純正ポップアウトのハンドラの代わり（バブリングで受ける）
    const reached: string[] = []
    document.addEventListener('click', (e) => void reached.push(e.type))
    document.addEventListener('keydown', (e) => void reached.push(e.type))
    return { b, deps, reached }
  }

  it('クリックで 1 回止め、純正のハンドラには届かせない（合成イベントでも止める）', () => {
    const { b, deps, reached } = setup()
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    b.dispatchEvent(ev)
    expect(deps.stopAll).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(reached).toEqual([])
  })

  it('Enter / Space で止め、キーリピートと他のキーでは止めない', () => {
    const { b, deps, reached } = setup()
    const key = (code: string, repeat = false): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true })
      b.dispatchEvent(ev)
      return ev
    }
    key('Enter')
    key('Space')
    expect(deps.stopAll).toHaveBeenCalledTimes(2)
    expect(key('Enter', true).defaultPrevented).toBe(true)
    expect(deps.stopAll).toHaveBeenCalledTimes(2)
    key('KeyA')
    expect(deps.stopAll).toHaveBeenCalledTimes(2)
    expect(reached).toEqual(['keydown'])
  })

  it('ホバーとフォーカスでツールチップを出し、離れたら消す', () => {
    const { b, deps } = setup()
    b.dispatchEvent(new Event('pointerenter'))
    expect(deps.showTip).toHaveBeenCalledWith(b)
    b.dispatchEvent(new Event('pointerleave'))
    expect(deps.hideTip).toHaveBeenCalled()
  })
})

describe('ほかの仕組みと干渉しない', () => {
  const PANEL = `<div class="actionButtons_e131a9"><button class="button_e131a9"></button><button class="button_e131a9" aria-label="サウンドボードを開く"></button></div>`

  it('音声パネルの探索、ロック解除の横取り、ビデオボタンを隠す CSS のどれにも拾われない', () => {
    document.body.innerHTML = PANEL + PICKER
    const volume = $('[class*="settingsClickArea"]')
    const b = buildSoundboardStopButton(document, volume)
    volume.after(b)
    expect(findSoundboardAnchor(document, { classes: { actionButtons: 'actionButtons_e131a9' } })?.anchor).toBe(
      $('[aria-label="サウンドボードを開く"]')
    )
    expect(findLockedSound(b)).toBeNull()
    expect(b.matches(`[${GRAFT_ATTR}="graft"]`)).toBe(false)
  })
})
