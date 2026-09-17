// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decideSoundboardUnlock,
  findLockedSound,
  installLockedSoundInterceptor,
  playingSoundboardCss,
  setSoundboardUnlocked,
  UNLOCK_SOUNDBOARD_ATTR,
  UNLOCK_SOUNDBOARD_CSS,
  type LockedSound
} from '../src/preload/lockedSounds.js'

/**
 * 純正サウンドボードの「Nitro が必要なサウンド」の横取り。
 *
 * 取り違えると、普通に鳴らせるサウンドまで VoiceCord に奪われる、プレビューやお気に入りが
 * 効かなくなる、ページ側の合成イベントで VC に音が流れる、のどれかになる。
 * fixture は Canary 1.0.1175 の実 DOM（svg の中身だけ省いた）。
 */

const lockedLi = (id: string, name: string): string =>
  `<li class="soundButtonWrapper__9be63"><div class="soundButton__9be63 animated__9be63 soundButtonInteractive__9be63"><div class="focusTarget__54e4b" role="button" data-list-item-id="NO_LIST___sound-${id}" tabindex="-1" id="sound-${id}" aria-label="⏰ ${name}をプレイする" aria-describedby="_r_9l_"></div><div class="soundInfo__9be63 hasEmoji__9be63" aria-hidden="true"><img class="emoji emoji__9be63" data-type="emoji" data-name="⏰" alt="⏰" src="/assets/x.svg"><div class="defaultColor__4bd52 text-xs/medium_cf4812 soundName__9be63 hasEmoji__9be63">${name}</div></div><div class="buttonOverlay__9be63"><div class="buttonOverlayBackground__9be63 absoluteFill__9be63"></div><div class="buttonOverlayActions__9be63 absoluteFill__9be63"><div><div class="secondaryButton__9be63" aria-label="プレビュー⏰ ${name}" role="button" tabindex="0"><svg class="secondaryIcon__9be63"></svg></div><span class="hiddenVisually_b18fe2">プレビュー⏰ ${name}</span></div><svg class="primaryIcon__9be63 lockIcon__9be63 hasEmoji__9be63"></svg><div><div class="secondaryButton__9be63" aria-label="⏰ ${name} をお気に入りに追加" role="button" tabindex="0"><svg class="secondaryIcon__9be63"></svg></div></div></div></div></div><span id="_r_9l_" class="hiddenVisually_b18fe2">${name}</span></li>`

/** ロックアイコンの無い（普通に鳴らせる）サウンド */
const openLi = (id: string, name: string): string =>
  lockedLi(id, name).replace('primaryIcon__9be63 lockIcon__9be63', 'primaryIcon__9be63 playIcon__9be63')

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!

let playing: LockedSound[]
let enabled: boolean
let trusted: boolean
let reachedPage: string[]
let uninstall: () => void

/** Discord のハンドラの代わり。window の capture より後に走る */
const PAGE_EVENTS = ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup']

const pageListener = (e: Event): void => void reachedPage.push(e.type)

beforeEach(() => {
  // 純正のサウンドボードはポップアウト（role="dialog"）の中に出る
  document.body.innerHTML = `<div role="dialog"><ul>${lockedLi('1366072719438905447', 'Windows Alarm')}${openLi('1366072719438905448', 'Open Sound')}</ul></div><div id="vc-root"><div role="dialog">${lockedLi('1366072719438905449', 'Ours')}</div></div><section class="soundboardSettings">${lockedLi('1366072719438905450', 'Outside')}</section>`
  playing = []
  enabled = true
  trusted = true
  reachedPage = []
  for (const t of PAGE_EVENTS) document.addEventListener(t, pageListener, true)
  uninstall = installLockedSoundInterceptor(window, {
    enabled: () => enabled,
    onPlay: (s) => void playing.push(s),
    isTrusted: () => trusted
  })
})

afterEach(() => {
  uninstall()
  for (const t of PAGE_EVENTS) document.removeEventListener(t, pageListener, true)
  document.documentElement.removeAttribute(UNLOCK_SOUNDBOARD_ATTR)
})

const pointerSeq = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('findLockedSound', () => {
  it('ロックされた li の中なら ID と名前を返す', () => {
    const expected = { soundId: '1366072719438905447', name: 'Windows Alarm' }
    expect(findLockedSound($('#sound-1366072719438905447'))).toEqual(expected)
    expect(findLockedSound($('[class*="soundName"]'))).toEqual(expected)
    expect(findLockedSound($('svg[class*="lockIcon"]'))).toEqual(expected)
  })

  it('プレビュー・お気に入り、ロックの無い li、自前 UI の中、li の外は null', () => {
    expect(findLockedSound($('[aria-label^="プレビュー"]'))).toBeNull()
    expect(findLockedSound($('[aria-label^="プレビュー"] svg'))).toBeNull()
    expect(findLockedSound($('[aria-label$="をお気に入りに追加"]'))).toBeNull()
    expect(findLockedSound($('#sound-1366072719438905448'))).toBeNull()
    expect(findLockedSound($('#sound-1366072719438905449'))).toBeNull()
    // ポップアウトの外（サーバー設定のサウンド一覧など）は対象にしない
    expect(findLockedSound($('#sound-1366072719438905450'))).toBeNull()
    expect(findLockedSound($('ul'))).toBeNull()
    expect(findLockedSound(null)).toBeNull()
    expect(findLockedSound(window)).toBeNull()
  })

  it('ID が数字でなければ null', () => {
    document.body.innerHTML = `<div role="dialog"><ul>${lockedLi('abc', 'X')}${lockedLi('1'.repeat(21), 'Y')}</ul></div>`
    expect(findLockedSound($('#sound-abc'))).toBeNull()
    expect(findLockedSound($(`[id="sound-${'1'.repeat(21)}"]`))).toBeNull()
  })
})

describe('installLockedSoundInterceptor', () => {
  it('ロックされたサウンドのクリックは純正へ届けず、クリック 1 回で 1 回だけ鳴らす', () => {
    const target = $('#sound-1366072719438905447')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    target.dispatchEvent(click)
    expect(reachedPage).toEqual([])
    expect(click.defaultPrevented).toBe(true)
    expect(playing).toEqual([{ soundId: '1366072719438905447', name: 'Windows Alarm' }])
  })

  it('Enter / Space の keydown で鳴らし、ほかのキーと押しっぱなしの繰り返しでは鳴らさない', () => {
    const target = $('#sound-1366072719438905447')
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    expect(playing).toHaveLength(2)
    // 繰り返しも純正には届けない（届けると Nitro の勧誘が出る）。関係ないキーは素通し
    expect(reachedPage).toEqual(['keydown'])
  })

  it('Enter / Space の keyup も純正へ届けないが、keyup では鳴らさない', () => {
    const target = $('#sound-1366072719438905447')
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, cancelable: true }))
    expect(playing).toEqual([])
    expect(reachedPage).toEqual(['keyup'])
  })

  it('左ボタン以外（右クリック・中クリック）は素通しする', () => {
    const target = $('#sound-1366072719438905447')
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { button: 2, bubbles: true, cancelable: true }))
    }
    target.dispatchEvent(new MouseEvent('click', { button: 1, bubbles: true, cancelable: true }))
    expect(playing).toEqual([])
    expect(reachedPage).toEqual(['pointerdown', 'mousedown', 'click', 'click'])
  })

  it('ポップアウトの外にあるロックされたサウンドは素通しする', () => {
    pointerSeq($('#sound-1366072719438905450'))
    expect(playing).toEqual([])
    expect(reachedPage).toEqual(['pointerdown', 'mousedown', 'click'])
  })

  it('プレビュー・お気に入り、ロックの無いサウンド、自前 UI の中は素通しする', () => {
    pointerSeq($('[aria-label^="プレビュー"]'))
    pointerSeq($('[aria-label$="をお気に入りに追加"]'))
    pointerSeq($('#sound-1366072719438905448'))
    pointerSeq($('#sound-1366072719438905449'))
    expect(playing).toEqual([])
    expect(reachedPage).toHaveLength(12)
  })

  it('設定が OFF なら何もしない', () => {
    enabled = false
    pointerSeq($('#sound-1366072719438905447'))
    expect(playing).toEqual([])
    expect(reachedPage).toEqual(['pointerdown', 'mousedown', 'click'])
  })

  it('本物の入力でなければ鳴らさない（純正の勧誘は止める）', () => {
    trusted = false
    pointerSeq($('#sound-1366072719438905447'))
    $('#sound-1366072719438905447').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    expect(playing).toEqual([])
    expect(reachedPage).toEqual([])
  })

  it('既定の判定は event.isTrusted を見る（jsdom の dispatchEvent は合成扱い）', () => {
    uninstall()
    uninstall = installLockedSoundInterceptor(window, {
      enabled: () => true,
      onPlay: (s) => void playing.push(s)
    })
    pointerSeq($('#sound-1366072719438905447'))
    expect(playing).toEqual([])
  })

  it('解除すると素通しに戻る', () => {
    uninstall()
    pointerSeq($('#sound-1366072719438905447'))
    expect(playing).toEqual([])
    expect(reachedPage).toEqual(['pointerdown', 'mousedown', 'click'])
  })
})

describe('ロックアイコンを隠す', () => {
  it('html の属性で切り替え、Discord の要素そのものには触らない', () => {
    const before = document.body.innerHTML
    setSoundboardUnlocked(document, true)
    expect(document.documentElement.hasAttribute(UNLOCK_SOUNDBOARD_ATTR)).toBe(true)
    setSoundboardUnlocked(document, false)
    expect(document.documentElement.hasAttribute(UNLOCK_SOUNDBOARD_ATTR)).toBe(false)
    expect(document.body.innerHTML).toBe(before)
  })

  it('CSS はすべて属性があるときだけ効き、ロックアイコンと Nitro の装飾・誘導を消す', () => {
    const rules = UNLOCK_SOUNDBOARD_CSS.split('}')
      .map((r) => r.trim())
      .filter((r) => r !== '')
    // セレクタ一覧のどの項目にも属性の印を付ける（1 つでも漏れると OFF でも効いてしまう）
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf('{')).split(',')
      for (const sel of selectors) expect(sel.trim().startsWith(`html[${UNLOCK_SOUNDBOARD_ATTR}] `)).toBe(true)
    }
    const gated = (sel: string): string => `html[${UNLOCK_SOUNDBOARD_ATTR}] ${sel}`
    const has = (sel: string, body: string): void => {
      const rule = rules.find((r) => r.split('{')[0]!.split(',').some((s) => s.trim() === gated(sel)))
      expect(rule, sel).toBeDefined()
      expect(rule!.slice(rule!.indexOf('{') + 1)).toBe(body)
    }
    has('[class*="soundButton__"] svg[class*="lockIcon"]', 'display:none !important')
    has('[class*="soundRowNitroLocked"]', 'background:none !important')
    has('[class*="sectionContainerNitroLockedBackground"]', 'background:var(--background-base-low) !important')
    // soundRowNitroLocked などに誤爆しないよう、class の単語の頭で合わせる
    has('[class^="nitroLocked__"]', 'background:none !important')
    has('[class*=" nitroLocked__"]', 'background:none !important')
    has('[class*="nitroTopDividerContainer"]', 'display:none !important')
    has('[role="dialog"] [class*="upsellContainerFloating"]', 'display:none !important')
    has('[class*="categoryItemLockIconContainer"]', 'display:none !important')
    expect(UNLOCK_SOUNDBOARD_CSS).not.toContain('[class*="nitroLocked__"]')
  })

  it('純正の Nitro 用の背景クラスには、単語の頭で合わせるセレクタだけが当たる', () => {
    document.body.innerHTML =
      '<div id="a" class="soundRow__61424 soundRowNitroLocked__61424"></div><div id="b" class="nitroLocked__61424 lastSectionFooter__61424"></div><div id="c" class="smallPaddingFooter__61424 nitroLocked__61424"></div>'
    const sel = '[class^="nitroLocked__"],[class*=" nitroLocked__"]'
    expect([...document.querySelectorAll(sel)].map((e) => e.id)).toEqual(['b', 'c'])
  })
})

describe('decideSoundboardUnlock', () => {
  it('設定 ON かつ UI があるときだけ横取りし、html に印を付ける', () => {
    expect(decideSoundboardUnlock({ setting: true, uiMounted: true })).toEqual({ intercept: true, markHtml: true })
    expect(decideSoundboardUnlock({ setting: false, uiMounted: true })).toEqual({ intercept: false, markHtml: false })
    // 鳴らす先が無いのに純正を止めると、押しても何も起きなくなる
    expect(decideSoundboardUnlock({ setting: true, uiMounted: false })).toEqual({ intercept: false, markHtml: false })
    expect(decideSoundboardUnlock({ setting: false, uiMounted: false })).toEqual({ intercept: false, markHtml: false })
  })
})

describe('playingSoundboardCss', () => {
  it('鳴らしているサウンド ID ごとに、純正の再生中と同じ緑の枠を付ける', () => {
    const css = playingSoundboardCss(['1366072719438905447', '1366072719438905448', '1366072719438905447'])
    expect(css).toContain('[id="sound-1366072719438905447"]')
    expect(css).toContain('[id="sound-1366072719438905448"]')
    expect(css.match(/sound-1366072719438905447/g)).toHaveLength(1)
    expect(css).toContain('var(--status-positive-background')
    expect(css.startsWith('[role="dialog"] [class*="soundButton__"]:has(> ')).toBe(true)
  })

  it('何も鳴っていなければ空、数字以外の ID はセレクタに入れない', () => {
    expect(playingSoundboardCss([])).toBe('')
    expect(playingSoundboardCss(['"]{}*{color:red}', 'abc'])).toBe('')
  })
})
