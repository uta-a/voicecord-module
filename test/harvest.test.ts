// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  findActionButtonClasses,
  harvestOnce,
  installHarvester,
  moduleCache,
  type HarvestWindow
} from '../src/mainworld/harvest.js'
import { HARVEST_REQUEST_EVENT, HARVEST_RESULT_EVENT, parseHarvestDetail } from '../src/shared/harvest.js'

/**
 * メインワールドの採取役。
 *
 * 一番守りたいのは「Vencord と webpack の掴み方で衝突しない」こと。Vencord は
 * Function.prototype.m に configurable:false の setter を仕掛ける。我々が同じ手を
 * 使うと後から定義した側が TypeError で落ちる（Stable には Vencord が居る）。
 */

const CSS_MODULE = {
  container: 'container_e131a9',
  actionButtons: 'actionButtons_e131a9',
  button: 'button_e131a9',
  buttonIcon: 'buttonIcon_e131a9',
  buttonContents: 'buttonContents_e131a9',
  buttonColor: 'buttonColor_e131a9'
}

afterEach(() => {
  delete (Function.prototype as unknown as Record<string, unknown>)['m']
})

/** webpack の jsonp push を模す。runtime 関数を __webpack_require__ で呼ぶ */
function fakeWebpackChunk(cache: Record<string, { exports: unknown }>): unknown[] {
  const arr: unknown[] = []
  const origPush = Array.prototype.push.bind(arr)
  arr.push = (...items: unknown[]) => {
    for (const item of items) {
      const runtime = (item as unknown[])[2]
      if (typeof runtime === 'function') runtime({ c: cache })
    }
    return origPush(...items)
  }
  return arr
}

describe('findActionButtonClasses', () => {
  it('短縮されたキーでも同じモジュールの列・ボタン・アイコンを拾う', () => {
    expect(findActionButtonClasses([{ uu: 'actionButtons_e131a9', x6: 'button_e131a9', iA: 'buttonIcon_e131a9' }]))
      .toEqual({ actionButtons: 'actionButtons_e131a9' })
    expect(findActionButtonClasses([{ uu: 'actionButtons_e131a9', x6: 'button_other', iA: 'buttonIcon_other' }]))
      .toBeNull()
  })
  it('列・ボタン・アイコンが揃った CSS モジュールだけを拾う', () => {
    const got = findActionButtonClasses([
      { actionButtons: 'other_1' }, // 列だけでは拾わない
      { default: CSS_MODULE }
    ])
    expect(got).toEqual({ actionButtons: CSS_MODULE.actionButtons })
  })

  it('window や Proxy らしきもの（不自然な Symbol.toStringTag）は読まない', () => {
    const touched: string[] = []
    const proxy = new Proxy(
      { [Symbol.toStringTag]: 'IntlMessagesProxy' },
      {
        get(target, key) {
          if (key !== Symbol.toStringTag) touched.push(String(key))
          return key === Symbol.toStringTag ? 'IntlMessagesProxy' : 'x_1'
        }
      }
    )
    expect(findActionButtonClasses([window, proxy, CSS_MODULE], window)).toEqual({
      actionButtons: CSS_MODULE.actionButtons
    })
    expect(touched).toEqual([])
  })

  it('getter が throw するモジュールがあっても続ける', () => {
    const bad = Object.defineProperty({}, 'actionButtons', {
      get() {
        throw new Error('boom')
      }
    })
    expect(findActionButtonClasses([bad, CSS_MODULE])).toEqual({ actionButtons: CSS_MODULE.actionButtons })
  })
})

describe('moduleCache', () => {
  it('複数 runtime の最後が小さい場合も主キャッシュを選ぶ', () => {
    const main = { 1: { exports: CSS_MODULE }, 2: { exports: {} } }
    const chunk: unknown[] = []
    chunk.push = (...items: unknown[]) => {
      const runtime = (items[0] as unknown[])[2] as (r: unknown) => void
      runtime({ c: main })
      runtime({})
      runtime({ c: { 3: { exports: {} } } })
      return Array.prototype.push.apply(chunk, items)
    }
    expect(moduleCache({ webpackChunkdiscord_app: chunk }).cache).toBe(main)
    expect(harvestOnce({ webpackChunkdiscord_app: chunk }).classes).toEqual({ actionButtons: CSS_MODULE.actionButtons })
    expect(chunk).toHaveLength(0)
  })
  it('Vencord が居ればそのキャッシュを借りる', () => {
    const cache = { 1: { exports: CSS_MODULE } }
    const win: HarvestWindow = { Vencord: { Webpack: { cache } }, webpackChunkdiscord_app: fakeWebpackChunk({}) }
    expect(moduleCache(win)).toMatchObject({ source: 'vencord', cache })
  })

  it('居なければ空チャンクで require を受け取り、積んだチャンクは残さない', () => {
    const cache = { 1: { exports: CSS_MODULE } }
    const chunk = fakeWebpackChunk(cache)
    const r = moduleCache({ webpackChunkdiscord_app: chunk })
    expect(r.source).toBe('webpack')
    expect(r.cache).toBe(cache)
    expect(chunk).toHaveLength(0)
  })

  it('webpack がまだ動いていなくても積みっぱなしにしない', () => {
    const chunk: unknown[] = []
    const r = moduleCache({ webpackChunkdiscord_app: chunk })
    expect(r.source).toBe('none')
    expect(chunk).toHaveLength(0)
  })

  it('Function.prototype に触らない（Vencord の m の setter と衝突しない）', () => {
    // Vencord と同じ形の、再定義できない setter を先に置く
    Object.defineProperty(Function.prototype, 'm', {
      set() {},
      configurable: true // テストの後始末のため。本物は false
    })
    const before = Object.getOwnPropertyDescriptor(Function.prototype, 'm')
    harvestOnce({ webpackChunkdiscord_app: fakeWebpackChunk({ 1: { exports: CSS_MODULE } }) })
    expect(Object.getOwnPropertyDescriptor(Function.prototype, 'm')).toEqual(before)
  })
})

describe('installHarvester', () => {
  it('結果を文字列で投げ、要求のたびに引き直す。二重に仕掛けない', () => {
    const cache: Record<string, { exports: unknown }> = {}
    const win: HarvestWindow = { webpackChunkdiscord_app: fakeWebpackChunk(cache) }
    const details: unknown[] = []
    document.addEventListener(HARVEST_RESULT_EVENT, (e) => details.push((e as CustomEvent).detail))
    const make = (type: string, detail: string): Event => new CustomEvent(type, { detail })

    expect(installHarvester(win, document, make)).toBe(true)
    expect(installHarvester(win, document, make)).toBe(false)
    expect(details).toHaveLength(1)
    expect(typeof details[0]).toBe('string')
    // VC に入る前は CSS モジュールがまだ無い
    expect(parseHarvestDetail(details[0])?.classes).toBeNull()

    cache['9'] = { exports: CSS_MODULE }
    document.dispatchEvent(new CustomEvent(HARVEST_REQUEST_EVENT))
    expect(details).toHaveLength(2)
    expect(parseHarvestDetail(details[1])?.classes).toEqual({ actionButtons: CSS_MODULE.actionButtons })
    // 理由は自由文ではなくコードで返す
    expect(JSON.parse(details[0] as string)).toMatchObject({ code: 'module-not-loaded' })
    expect(JSON.parse(details[0] as string)).not.toHaveProperty('error')
  })
})
