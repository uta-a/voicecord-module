import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardTrusted, isTrustedInput } from '../src/ui/lib/trusted.js'

/**
 * 本物の入力かどうかの検査。
 *
 * VoiceCord の UI は Discord のページと同じ DOM にある。ページ側のスクリプト（悪意のある
 * 埋め込みや他の mod）が合成クリックを送ると、ユーザーが押していないのに VC へ音が流れる。
 * 送信につながる操作だけ、ブラウザ自身が作ったイベント（isTrusted === true）に限る。
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isTrustedInput', () => {
  it('React の合成イベントでも、元のネイティブイベントの isTrusted で見る', () => {
    expect(isTrustedInput({ nativeEvent: { isTrusted: true } })).toBe(true)
    expect(isTrustedInput({ nativeEvent: { isTrusted: false }, isTrusted: true })).toBe(false)
  })

  it('ネイティブイベントをそのまま渡してもよい', () => {
    expect(isTrustedInput({ isTrusted: true })).toBe(true)
    expect(isTrustedInput({ isTrusted: false })).toBe(false)
  })

  it('判定できないものは本物と見なさない', () => {
    expect(isTrustedInput({})).toBe(false)
    expect(isTrustedInput(null)).toBe(false)
    expect(isTrustedInput(undefined)).toBe(false)
  })
})

describe('guardTrusted', () => {
  it('本物の入力なら処理を呼ぶ', () => {
    const fn = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = { nativeEvent: { isTrusted: true } }
    guardTrusted('タイルの再生', fn)(e)
    expect(fn).toHaveBeenCalledWith(e)
    expect(warn).not.toHaveBeenCalled()
  })

  it('合成の入力は無視し、黙らせずに console.warn を 1 行出す', () => {
    const fn = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    guardTrusted('タイルの再生', fn)({ nativeEvent: { isTrusted: false } })
    expect(fn).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('タイルの再生')
  })
})
