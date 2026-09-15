// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHarvestClient,
  findSoundboardAnchor,
  GRAFT_ATTR,
  pickSoundboardButton
} from '../src/preload/anchor.js'
import {
  HARVEST_REQUEST_EVENT,
  HARVEST_RESULT_EVENT,
  parseHarvestDetail,
  sanitizeClassList
} from '../src/shared/harvest.js'

/**
 * 純正サウンドボードボタンの発見。
 *
 * DOM の形は 2026-09-14 に Canary 1.0.1169 で実測したもの:
 *   div.container_e131a9 > div.actionButtons_e131a9 >
 *     button × 4（カメラ / 画面共有 / アクティビティ / サウンドボード）
 *   サウンドボードだけが aria-label「サウンドボードを開く」を持ち、
 *   他の 3 つは隣の span.hiddenVisually で名前を持つ。アイコンは lottie。
 */

function lottieButton(label?: string): string {
  const aria = label ? ` aria-label="${label}"` : ''
  return `<button class="button_e131a9 buttonColor_e131a9 grow__201d5"${aria}><div class="contents__201d5 buttonContents_e131a9"><div class="lottieIcon__5eb9b buttonIcon_e131a9"><svg></svg></div></div></button>`
}

function voicePanel(): string {
  return `<div class="container_e131a9"><div class="actionButtons_e131a9">
    ${lottieButton()}<span class="hiddenVisually_b18fe2">カメラをオン</span>
    ${lottieButton()}<span class="hiddenVisually_b18fe2">画面を共有する</span>
    ${lottieButton()}<span class="hiddenVisually_b18fe2">アクティビティを開始</span>
    ${lottieButton('サウンドボードを開く')}
  </div></div>`
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('findSoundboardAnchor', () => {
  it('ツールチップの単独ラッパー内のボタンも 1 段目で見つける', () => {
    document.body.innerHTML = `<div class="actionButtons_e131a9">${lottieButton()}<div><div>${lottieButton('サウンドボードを開く')}</div></div></div>`
    expect(findSoundboardAnchor(document, { classes: { actionButtons: 'actionButtons_e131a9' } })?.tier).toBe(1)
  })
  it('1 段目: 採取役のクラス名で見つける', () => {
    document.body.innerHTML = voicePanel()
    const hit = findSoundboardAnchor(document, { classes: { actionButtons: 'actionButtons_e131a9' } })
    expect(hit?.tier).toBe(1)
    expect(hit?.anchor.getAttribute('aria-label')).toBe('サウンドボードを開く')
  })

  it('2 段目: 採取役が無ければハッシュ前の部分で見つける', () => {
    document.body.innerHTML = voicePanel()
    const hit = findSoundboardAnchor(document, { classes: null })
    expect(hit?.tier).toBe(2)
    expect(hit?.anchor.getAttribute('aria-label')).toBe('サウンドボードを開く')
  })

  it('採取役のクラス名が古くなっていたら 2 段目に落ちる', () => {
    document.body.innerHTML = voicePanel()
    const hit = findSoundboardAnchor(document, { classes: { actionButtons: 'actionButtons_old000' } })
    expect(hit?.tier).toBe(2)
  })

  it('文言の無い別の actionButtons_ 列を先に拾わない', () => {
    // 同じ CSS モジュールの列が他の画面（ボタン 2 つ）にもある場合
    document.body.innerHTML = `<div class="actionButtons_e131a9"><button id="wrong1"></button><button id="wrong2"></button></div>${voicePanel()}`
    for (const classes of [null, { actionButtons: 'actionButtons_e131a9' }]) {
      const hit = findSoundboardAnchor(document, { classes, inVc: true })
      expect(hit?.anchor.getAttribute('aria-label')).toBe('サウンドボードを開く')
    }
  })

  it('文言が無いときに最後のボタンを採るのは、lottie のボタンが 4 つ以上並ぶ列だけ', () => {
    document.body.innerHTML = `<div class="actionButtons_e131a9"><button></button><button></button></div>`
    expect(findSoundboardAnchor(document, { classes: null, inVc: true })).toBeNull()
    document.body.innerHTML = voicePanel().replace(' aria-label="サウンドボードを開く"', '')
    const hit = findSoundboardAnchor(document, { classes: null, inVc: true })
    expect(hit?.tier).toBe(2)
    expect(hit?.anchor).toBe(document.querySelector('.actionButtons_e131a9')!.lastElementChild)
  })

  it('1 段目は偽の採取結果で任意の位置に付かない（文言か構造で確かめる）', () => {
    document.body.innerHTML = `<div class="chatArea_zz"><button id="send"></button></div>`
    const hit = findSoundboardAnchor(document, { classes: { actionButtons: 'chatArea_zz' }, inVc: true })
    expect(hit).toBeNull()
  })

  it('3 段目: クラス名の形が変わっても文言で見つける', () => {
    document.body.innerHTML = `<div class="row_x"><button aria-label="Open Soundboard"></button></div>`
    expect(findSoundboardAnchor(document, { classes: null })?.tier).toBe(3)
  })

  it('3 段目の文言は完全一致だけ（「サウンドボード」を含む別のボタンに付かない）', () => {
    document.body.innerHTML = `<div class="row_x"><button aria-label="サウンドボードの音量"></button><button aria-label="サウンドボード"></button></div>`
    expect(findSoundboardAnchor(document, { classes: null, inVc: true })).toBeNull()
  })

  it('4 段目は VC 中だけ試す（毎フレームの全文書走査を減らす）', () => {
    document.body.innerHTML = `<div class="row_x">${lottieButton()}${lottieButton()}${lottieButton()}${lottieButton()}</div>`
    expect(findSoundboardAnchor(document, { classes: null, inVc: false })).toBeNull()
  })

  it('4 段目: 文言も変わったら lottie のボタン列の最後', () => {
    document.body.innerHTML = `<div class="row_x">${lottieButton()}${lottieButton()}${lottieButton()}${lottieButton()}</div>`
    const hit = findSoundboardAnchor(document, { classes: null, inVc: true })
    expect(hit?.tier).toBe(4)
    expect(hit?.anchor).toBe(document.querySelector('.row_x')!.lastElementChild)
  })

  it('lottie のボタンが 3 つしかない列（ユーザーパネル）には付かない', () => {
    document.body.innerHTML = `<div class="panel_x">${lottieButton()}${lottieButton()}${lottieButton()}</div>`
    expect(findSoundboardAnchor(document, { classes: null, inVc: true })).toBeNull()
  })

  it('VC に居なければ（音声パネルが無ければ）null', () => {
    document.body.innerHTML = '<div class="chat"><button class="expression-picker-chat-input-button"></button></div>'
    expect(findSoundboardAnchor(document, { classes: { actionButtons: 'actionButtons_e131a9' } })).toBeNull()
  })

  it('接ぎ木した自分のボタンをアンカーと取り違えない', () => {
    document.body.innerHTML = voicePanel()
    const row = document.querySelector('.actionButtons_e131a9')!
    const ours = document.createElement('button')
    ours.setAttribute(GRAFT_ATTR, 'graft')
    ours.setAttribute('aria-label', 'VoiceCord')
    row.appendChild(ours)
    const hit = findSoundboardAnchor(document, { classes: null })
    expect(hit?.anchor).not.toBe(ours)
    expect(hit?.anchor.getAttribute('aria-label')).toBe('サウンドボードを開く')
  })

  it('#vc-root の中は探さない', () => {
    document.body.innerHTML = `<div id="vc-root"><button aria-label="サウンドボード"></button></div>`
    const root = document.getElementById('vc-root')
    expect(findSoundboardAnchor(document, { classes: null, ignoreWithin: root })).toBeNull()
  })
})

describe('pickSoundboardButton', () => {
  it('文言が合うボタンを優先し、無ければ構造条件を満たす列の最後のボタン', () => {
    const div = document.createElement('div')
    div.innerHTML = `<button aria-label="サウンドボードを開く"></button><button></button>`
    expect(pickSoundboardButton(div)).toBe(div.firstElementChild)
    div.innerHTML = `<button></button><button id="last"></button>`
    expect(pickSoundboardButton(div)).toBeNull()
    div.innerHTML = `${lottieButton()}${lottieButton()}${lottieButton()}${lottieButton().replace('<button', '<button id="last"')}`
    expect(pickSoundboardButton(div)?.id).toBe('last')
  })
})

describe('sanitizeClassList / parseHarvestDetail', () => {
  it('クラス名として妥当な文字列だけを通す', () => {
    expect(sanitizeClassList('actionButtons_e131a9')).toBe('actionButtons_e131a9')
    expect(sanitizeClassList('a_1  b_2')).toBe('a_1 b_2')
    // セレクタや HTML として解釈されうる値は丸ごと捨てる
    expect(sanitizeClassList('a_1 "><img src=x>')).toBeNull()
    expect(sanitizeClassList('a, body')).toBeNull()
    expect(sanitizeClassList(42)).toBeNull()
    expect(sanitizeClassList('')).toBeNull()
  })

  it('メインワールドから届いた値は形を確かめてから使う', () => {
    const ok = parseHarvestDetail(
      JSON.stringify({ source: 'webpack', classes: { actionButtons: 'actionButtons_e131a9', button: 'x y{' }, code: null })
    )
    expect(ok?.source).toBe('webpack')
    expect(ok?.classes).toEqual({ actionButtons: 'actionButtons_e131a9' })
    expect(parseHarvestDetail('not json')).toBeNull()
    // 自由文は受け取らない。既知のコードだけを通し、それ以外は unknown に丸める
    const coded = parseHarvestDetail(
      JSON.stringify({ source: 'webpack', classes: null, code: 'module-not-loaded', error: '<b>偽の文言</b>' })
    )
    expect(coded?.code).toBe('module-not-loaded')
    expect(coded).not.toHaveProperty('error')
    expect(parseHarvestDetail(JSON.stringify({ source: 'webpack', classes: null, code: '任意の文' }))?.code).toBe('unknown')
    expect(parseHarvestDetail({ source: 'webpack' })).toBeNull() // 文字列以外（ワールドを跨げない形）
    expect(parseHarvestDetail('x'.repeat(5000))).toBeNull()
    // 列のクラスが無ければ使い道が無い
    expect(parseHarvestDetail(JSON.stringify({ source: 'evil', classes: { button: 'b' } }))).toEqual({
      source: 'none',
      classes: null,
      code: null
    })
  })
})

describe('createHarvestClient', () => {
  function client(t: { now: number }, minNotifyMs = 500) {
    const timers: Array<{ at: number; fn: () => void }> = []
    const c = createHarvestClient({
      doc: document,
      makeEvent: (type) => new CustomEvent(type),
      now: () => t.now,
      minIntervalMs: 2000,
      minNotifyMs,
      setTimer: (fn, ms) => void timers.push({ at: t.now + ms, fn })
    })
    const run = (): void => {
      for (const x of timers.splice(0).sort((a, b) => a.at - b.at)) x.fn()
    }
    return { c, run }
  }
  const result = (cls = 'actionButtons_e131a9'): CustomEvent =>
    new CustomEvent(HARVEST_RESULT_EVENT, {
      detail: JSON.stringify({ source: 'vencord', classes: { actionButtons: cls }, code: null })
    })

  it('結果を受け取り、形の違う値は無視する', () => {
    const t = { now: 0 }
    const { c } = client(t)
    document.dispatchEvent(result())
    expect(c.classes()).toEqual({ actionButtons: 'actionButtons_e131a9' })
    const n = c.results()
    document.dispatchEvent(new CustomEvent(HARVEST_RESULT_EVENT, { detail: '{' }))
    expect(c.results()).toBe(n)
  })

  it('引き直しは間隔を空け、同期で投げない（呼び出し側の処理に入れ子で割り込まない）', () => {
    const t = { now: 0 }
    const requests: string[] = []
    const onReq = (): void => void requests.push('req')
    document.addEventListener(HARVEST_REQUEST_EVENT, onReq)
    const { c, run } = client(t)
    c.request()
    expect(requests).toHaveLength(0)
    run()
    expect(requests).toHaveLength(1)
    c.request()
    run()
    expect(requests).toHaveLength(1)
    t.now = 2500
    c.request()
    run()
    expect(requests).toHaveLength(2)
    document.removeEventListener(HARVEST_REQUEST_EVENT, onReq)
  })

  it('結果の連打は間引いて通知する（最後の 1 回は必ず届く）', () => {
    const t = { now: 0 }
    const { c, run } = client(t)
    let notified = 0
    c.onResult(() => notified++)
    for (let i = 0; i < 50; i++) document.dispatchEvent(result(`actionButtons_${i}`))
    expect(notified).toBe(1)
    run()
    expect(notified).toBe(2)
    expect(c.classes()).toEqual({ actionButtons: 'actionButtons_49' })
  })
})
