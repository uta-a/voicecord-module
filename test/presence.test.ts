import { describe, expect, it } from 'vitest'
import { ANCHOR_MISSING_GRACE_MS, decideFab, readVcSignal, type PresenceInput } from '../src/preload/presence.js'

/**
 * FAB を出すかの判定。
 *
 * 平常時に FAB を出すと Discord の操作を塞ぐ（VC 全画面の「ポップアウト」ボタンで踏んだ）。
 * 故障時に出さないと、VoiceCord が消えたように見えて理由が読めない。
 */

const base: PresenceInput = {
  uiMounted: true,
  grafted: false,
  tripped: false,
  inVc: false,
  missingSince: null,
  now: 10_000,
  engine: 'attached',
  problems: false
}

describe('decideFab', () => {
  it('接ぎ木できていれば出さない', () => {
    expect(decideFab({ ...base, grafted: true, inVc: true })).toEqual({ fab: false })
  })

  it('VC に居なければ出さない（純正ボタンが無いところには出さない）', () => {
    expect(decideFab(base)).toEqual({ fab: false })
  })

  it('VC に居るのに純正ボタンが無い状態が猶予を超えたら出す', () => {
    const missing = { ...base, inVc: true, missingSince: base.now - 100 }
    expect(decideFab(missing)).toEqual({ fab: false })
    expect(
      decideFab({ ...missing, missingSince: base.now - ANCHOR_MISSING_GRACE_MS })
    ).toEqual({ fab: true, reason: 'anchor-missing' })
  })

  it('再挿入の上限を超えて諦めたら出す', () => {
    expect(decideFab({ ...base, tripped: true })).toEqual({ fab: true, reason: 'reinsert-storm' })
  })

  it('UI が読み込めなければ常に出す（理由を読める唯一の場所）', () => {
    expect(decideFab({ ...base, uiMounted: false, grafted: true })).toEqual({ fab: true, reason: 'ui-failed' })
  })

  it('接ぎ木できていない場所でエンジンが壊れていれば出す', () => {
    expect(decideFab({ ...base, engine: 'failed' })).toEqual({ fab: true, reason: 'engine-problem' })
    expect(decideFab({ ...base, problems: true })).toEqual({ fab: true, reason: 'engine-problem' })
    // 接ぎ木できていればポップアウトの中で理由が読めるので出さない
    expect(decideFab({ ...base, engine: 'failed', grafted: true })).toEqual({ fab: false })
  })
})

describe('readVcSignal', () => {
  it('engine のイベントから VC の在否だけを、形を確かめて読む', () => {
    expect(readVcSignal({ ev: 'vc', active: true })).toBe('in')
    expect(readVcSignal({ ev: 'vc', active: false })).toBe('out')
    expect(readVcSignal({ ev: 'engineLost', code: 9 })).toBe('out')
    expect(readVcSignal({ ev: 'detached', reason: 'x' })).toBe('out')
    expect(readVcSignal({ ev: 'gate', open: true })).toBeNull()
    // 形の違う値は無視する（active が真偽値でなければ在席と見なさない）
    expect(readVcSignal({ ev: 'vc', active: 'yes' })).toBeNull()
    expect(readVcSignal(null)).toBeNull()
    expect(readVcSignal('vc')).toBeNull()
  })
})
