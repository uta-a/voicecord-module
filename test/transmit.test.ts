import { describe, expect, it } from 'vitest'
import { FridaGate, type GateOptions, type GateTarget, type GateTimers } from '../src/engine/transmit.js'

/**
 * 送信ゲート。
 *
 * ここの分岐はどれも実機の事故から生まれたもので、壊れると
 * 「マイクが開きっぱなしになる」「注入音の頭が欠ける」「鳴っていないのに送信が続く」の
 * いずれかになる。どれも 2 人目のリスナー無しでは気付けないので、機械的に見る。
 */

interface Harness {
  gate: FridaGate
  calls: string[]
  /** 予約されているタイマーを 1 つ発火させ、その遅延を返す */
  fire(): number
  delays(): number[]
}

function harness(opts: GateOptions = {}): Harness {
  const calls: string[] = []
  const target: GateTarget = {
    gateOpen: () => void calls.push('open'),
    gateClose: () => void calls.push('close'),
    gateReset: () => void calls.push('reset')
  }
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let seq = 0
  const fakeTimers: GateTimers = {
    setTimeout: (fn, ms) => {
      const h = ++seq
      timers.set(h, { fn, ms })
      return h
    },
    clearTimeout: (h) => void timers.delete(h as number)
  }
  return {
    gate: new FridaGate(target, { ...opts, timers: opts.timers ?? fakeTimers }),
    calls,
    fire: () => {
      const [h, t] = [...timers.entries()][0] as [number, { fn: () => void; ms: number }]
      timers.delete(h)
      t.fn()
      return t.ms
    },
    delays: () => [...timers.values()].map((t) => t.ms)
  }
}

describe('preOpen', () => {
  it('先に開く（ゲートは Connection* 捕捉まで噛まないので、頭が欠ける）', () => {
    const h = harness()
    h.gate.preOpen(1500)
    expect(h.calls).toEqual(['open'])
    expect(h.gate.isOpen).toBe(true)
  })

  it('guardMs 以内に再生が始まらなければ閉じる（開きっぱなしにしない）', () => {
    const h = harness()
    h.gate.preOpen(1500)
    expect(h.fire()).toBe(1500)
    expect(h.calls).toEqual(['open', 'close'])
    expect(h.gate.isOpen).toBe(false)
  })

  it('再生が始まったらガードは取り消す', () => {
    const h = harness()
    h.gate.preOpen(1500)
    h.gate.onActivity(true)
    // 予約が残っていないこと。残っていると再生中に閉じてしまう
    expect(h.delays()).toEqual([])
    expect(h.calls).toEqual(['open'])
  })

  it('二重に開かない', () => {
    const h = harness()
    h.gate.preOpen(1500)
    h.gate.preOpen(1500)
    expect(h.calls).toEqual(['open'])
  })
})

describe('onActivity', () => {
  it('鳴り始めで開く', () => {
    const h = harness()
    h.gate.onActivity(true)
    expect(h.calls).toEqual(['open'])
  })

  it('止まってもすぐには閉じない（連続再生の隙間で無駄に閉じない）', () => {
    const h = harness({ revertDelayMs: 1000 })
    h.gate.onActivity(true)
    h.gate.onActivity(false)
    expect(h.calls).toEqual(['open'])
    expect(h.fire()).toBe(1000)
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('遅延中に鳴り直したら閉じない', () => {
    const h = harness()
    h.gate.onActivity(true)
    h.gate.onActivity(false)
    h.gate.onActivity(true)
    expect(h.delays()).toEqual([])
    expect(h.calls).toEqual(['open'])
  })

  it('enabled:false なら何もしない', () => {
    const h = harness({ enabled: false })
    h.gate.preOpen(1500)
    h.gate.onActivity(true)
    expect(h.calls).toEqual([])
  })
})

describe('onVcActive', () => {
  it('退出は即断しない。継続して初めて強制送信フラグを下ろす', () => {
    const h = harness({ vcRevertDelayMs: 2500 })
    h.gate.onActivity(true)
    h.gate.onVcActive(false)
    expect(h.calls).toEqual(['open'])
    expect(h.fire()).toBe(2500)
    // SetPTTActive は呼ばない（解放済み Connection* を触らない）
    expect(h.calls).toEqual(['open', 'reset'])
  })

  it('一過性の vc=false は退出と確定しない（hb 停滞で誤確定すると常時送信が stuck する）', () => {
    const h = harness()
    h.gate.onActivity(true)
    h.gate.onVcActive(false)
    h.gate.onVcActive(true)
    // vc の確定タイマーが取り消され、reset されていないこと
    expect(h.calls).toEqual(['open'])
    expect(h.delays()).toEqual([])
  })

  it('誤確定のあと VC が生きていたら、まだ再生中なら開き直す', () => {
    const h = harness()
    h.gate.onActivity(true)
    h.gate.onVcActive(false)
    h.fire() // 誤って退出と確定 → reset（open=false になるが playing も落ちる）
    expect(h.calls).toEqual(['open', 'reset'])

    // 実際には鳴り続けていた
    h.gate.onActivity(true)
    expect(h.calls).toEqual(['open', 'reset', 'open'])
  })

  it('VC が戻ったのに鳴っていなければ閉じにいく', () => {
    const h = harness()
    h.gate.preOpen(1500) // 開いているが playing ではない
    h.gate.onVcActive(true)
    expect(h.calls).toEqual(['open', 'close'])
  })
})

describe('セッション境界', () => {
  it('revertNow は playing も落とす（次の attach へ持ち越さない）', () => {
    const h = harness()
    h.gate.onActivity(true)
    expect(h.gate.isPlaying).toBe(true)
    h.gate.revertNow()
    expect(h.calls).toEqual(['open', 'close'])
    expect(h.gate.isPlaying).toBe(false)
    expect(h.gate.isOpen).toBe(false)
    expect(h.delays()).toEqual([])
  })

  it('playing を落とさないと、再アタッチ後に鳴っていないのにゲートが開く', () => {
    // revertNow が playing を残した場合に起きる事故の再現。
    // 正しく落ちていれば、VC 復帰で開き直す分岐は成立しない
    const h = harness()
    h.gate.onActivity(true)
    h.gate.revertNow()
    h.gate.onVcActive(true)
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('clearForced は close ではなく reset を使う', () => {
    const h = harness()
    h.gate.onActivity(true)
    h.gate.clearForced()
    expect(h.calls).toEqual(['open', 'reset'])
    expect(h.gate.isPlaying).toBe(false)
  })
})

describe('壊れても止まらない', () => {
  it('注入先が投げてもゲートは動き続け、理由を通知する', () => {
    const notes: string[] = []
    const bad: GateTarget = {
      gateOpen: () => {
        throw new Error('script が居ません')
      },
      gateClose: () => {},
      gateReset: () => {}
    }
    const gate = new FridaGate(bad, { onStatus: (m) => void notes.push(m) })
    expect(() => gate.onActivity(true)).not.toThrow()
    expect(notes.some((n) => n.includes('gate error'))).toBe(true)
  })

  it('通知先が投げてもゲートは動き続ける', () => {
    const gate = new FridaGate(
      { gateOpen: () => {}, gateClose: () => {}, gateReset: () => {} },
      {
        onStatus: () => {
          throw new Error('購読者が死んでいる')
        }
      }
    )
    expect(() => gate.onActivity(true)).not.toThrow()
  })
})
