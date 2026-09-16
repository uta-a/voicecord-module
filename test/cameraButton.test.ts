// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CAMERA_HIDDEN_ATTR, CAMERA_HIDE_CSS, setCameraButtonHidden } from '../src/preload/cameraButton.js'
import { GRAFT_ATTR } from '../src/preload/anchor.js'

describe('ビデオボタンを隠す', () => {
  it('html の属性で切り替え、Discord の要素そのものには触らない', () => {
    document.body.innerHTML = '<div class="actionButtons_x"><div><button></button></div></div>'
    const before = document.body.innerHTML
    setCameraButtonHidden(document, true)
    expect(document.documentElement.hasAttribute(CAMERA_HIDDEN_ATTR)).toBe(true)
    setCameraButtonHidden(document, false)
    expect(document.documentElement.hasAttribute(CAMERA_HIDDEN_ATTR)).toBe(false)
    expect(document.body.innerHTML).toBe(before)
  })

  it('CSS は属性があり、列に自前ボタンがあるときだけ、先頭の子を隠す', () => {
    expect(CAMERA_HIDE_CSS).toContain(`[${CAMERA_HIDDEN_ATTR}]`)
    expect(CAMERA_HIDE_CSS).toContain(`:has(> [${GRAFT_ATTR}="graft"])`)
    expect(CAMERA_HIDE_CSS).toContain('> :first-child')
    // 列の先頭がサウンドボード自身（直後が自前ボタン）のときは隠さない
    expect(CAMERA_HIDE_CSS).toContain(`:not(:has(+ [${GRAFT_ATTR}]))`)
  })
})
