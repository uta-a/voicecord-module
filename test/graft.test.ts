// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { findSoundboardAnchor, GRAFT_ATTR } from '../src/preload/anchor.js'
import {
  buildGraftButton,
  createGraft,
  MAX_INSERTS_PER_WINDOW,
  refreshGraftButton,
  RETRY_AFTER_TRIP_MS,
  stripStateTokens,
  type GraftState
} from '../src/preload/graft.js'

/**
 * 接ぎ木と再挿入。
 *
 * ここが暴走すると Discord ごと固まる（MutationObserver の自己トリガ）。
 * 逆に弱すぎると、チャンネル移動のたびにボタンが消えたままになる。
 */

const PANEL = `<div class="container_e131a9"><div class="actionButtons_e131a9">
  <button class="button_e131a9 grow__201d5"></button>
  <button class="button_e131a9 greyButtonActive_e131a9 grow__201d5" aria-label="サウンドボードを開く" aria-expanded="true" aria-controls="popout_40" id="x"><div class="contents__201d5"><div class="lottieIcon__5eb9b" style="width: 18px; height: 18px"><svg id="__lottie_element_1"></svg></div></div></button>
</div></div>`

interface Harness {
  states: GraftState[]
  graft: ReturnType<typeof createGraft>
  setNow: (t: number) => void
  root: HTMLElement
  finds: () => number
  /** 予約された処理（rAF 相当とタイマー） */
  pending: Array<() => void>
  timers: Array<{ ms: number; fn: () => void }>
}

function harness(opts: { deferSchedule?: boolean } = {}): Harness {
  const root = document.createElement('div')
  root.id = 'vc-root'
  document.body.appendChild(root)
  let now = 0
  let finds = 0
  const states: GraftState[] = []
  const pending: Array<() => void> = []
  const timers: Array<{ ms: number; fn: () => void }> = []
  const graft = createGraft({
    doc: document,
    ignoreWithin: root,
    find: () => {
      finds++
      return findSoundboardAnchor(document, { classes: null, ignoreWithin: root, inVc: true })
    },
    build: (a) => buildGraftButton(document, a, 'VoiceCord'),
    refresh: refreshGraftButton,
    onChange: (s) => states.push(s),
    now: () => now,
    // テストでは同期で探す（rAF を待たない）。遅延させたいテストだけ溜める
    schedule: (fn) => (opts.deferSchedule ? void pending.push(fn) : fn()),
    setTimer: (fn, ms) => void timers.push({ ms, fn })
  })
  return { states, graft, setNow: (t) => void (now = t), root, finds: () => finds, pending, timers }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('buildGraftButton', () => {
  it('純正の見た目を写し、純正との結び付きと状態クラスは写さない', () => {
    document.body.innerHTML = PANEL
    const anchor = document.querySelector<HTMLElement>('[aria-label="サウンドボードを開く"]')!
    const b = buildGraftButton(document, anchor, 'VoiceCord')
    expect(b.className).toBe('button_e131a9 grow__201d5')
    expect(b.getAttribute('aria-label')).toBe('VoiceCord')
    expect(b.getAttribute(GRAFT_ATTR)).toBe('graft')
    expect(b.hasAttribute('aria-controls')).toBe(false)
    expect(b.hasAttribute('id')).toBe(false)
    // lottie の SVG（id 付き）は自前のアイコンに差し替わる
    expect(b.querySelector('[id]')).toBeNull()
    expect(b.querySelector('.lottieIcon__5eb9b svg rect')).not.toBeNull()
    // 絵文字を使わない
    expect(b.textContent).toBe('')
  })

  it('stripStateTokens は active を含むクラスだけ外す', () => {
    expect(stripStateTokens('a_1 greyButtonActive_x b_2')).toBe('a_1 b_2')
  })
})

describe('createGraft', () => {
  it('純正ボタンの直後に挿入し、段位を返す', () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    const s = h.graft.state()
    expect(s.tier).toBe(2)
    expect(s.button?.previousElementSibling?.getAttribute('aria-label')).toBe('サウンドボードを開く')
    expect(s.inserts).toBe(1)
    h.graft.stop()
  })

  it('純正ボタンが無ければ出さない（VC 外・DM）', () => {
    document.body.innerHTML = '<div>chat</div>'
    const h = harness()
    h.graft.start()
    expect(h.graft.state()).toMatchObject({ tier: null, button: null, inserts: 0 })
    h.graft.stop()
  })

  it('React に外されたら戻す', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    h.graft.state().button!.remove()
    await flush()
    expect(h.graft.state().button).not.toBeNull()
    expect(h.graft.state().inserts).toBe(2)
    h.graft.stop()
  })

  it('音声パネルごと作り直されたら新しい純正ボタンの隣へ移る', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    document.body.firstElementChild!.remove()
    document.body.insertAdjacentHTML('afterbegin', PANEL)
    await flush()
    const s = h.graft.state()
    expect(s.button?.previousElementSibling?.getAttribute('aria-label')).toBe('サウンドボードを開く')
    h.graft.stop()
  })

  it('VC を抜けて純正ボタンが消えたら自分も消える', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    document.querySelector('.container_e131a9')!.remove()
    await flush()
    expect(h.graft.state().button).toBeNull()
    expect(document.querySelector(`[${GRAFT_ATTR}]`)).toBeNull()
    h.graft.stop()
  })

  it('自分の挿入で自分を再トリガしない', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    await flush()
    await flush()
    expect(h.graft.state().inserts).toBe(1)
    h.graft.stop()
  })

  it('#vc-root の中の変化では探し直さない（ポップアウトの再描画）', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    const before = h.states.length
    for (let i = 0; i < 20; i++) h.root.appendChild(document.createElement('span'))
    await flush()
    expect(h.states.length).toBe(before)
    h.graft.stop()
  })

  it(`1 秒に ${MAX_INSERTS_PER_WINDOW} 回を超えて外され続けたら諦める`, () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start() // 1 回目
    for (let i = 0; i < MAX_INSERTS_PER_WINDOW + 2; i++) {
      h.graft.state().button?.remove()
      h.graft.sync(true)
    }
    const s = h.graft.state()
    expect(s.tripped).toBe(true)
    expect(s.button).toBeNull()
    expect(s.inserts).toBe(MAX_INSERTS_PER_WINDOW)
    // 諦めた後は探しもしない
    h.graft.sync(true)
    expect(h.graft.state().inserts).toBe(MAX_INSERTS_PER_WINDOW)
    h.graft.stop()
  })

  it('間隔が空いていれば上限に数えない', () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    for (let i = 1; i <= MAX_INSERTS_PER_WINDOW * 3; i++) {
      h.setNow(i * 1500)
      h.graft.state().button?.remove()
      h.graft.sync(true)
    }
    expect(h.graft.state().tripped).toBe(false)
    h.graft.stop()
  })

  it('純正ボタンのクラスが変わったら写し直す', () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    const anchor = document.querySelector<HTMLElement>('[aria-label="サウンドボードを開く"]')!
    anchor.className = 'button_e131a9 themed_zz'
    h.graft.sync(true)
    expect(h.graft.state().button?.className).toBe('button_e131a9 themed_zz')
    h.graft.stop()
  })

  it('接ぎ木済みで隣接関係が変わっていなければ、無関係な変化で全文書を探し直さない', async () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    const before = h.finds()
    for (let i = 0; i < 10; i++) document.body.appendChild(document.createElement('p'))
    await flush()
    expect(h.finds()).toBe(before)
    // 外から強制したとき（新しい採取結果が届いた等）は探し直す
    h.graft.sync(true)
    expect(h.finds()).toBe(before + 1)
    h.graft.stop()
  })

  it('stop の後は、予約済みの探索も外からの sync も走らない', async () => {
    document.body.innerHTML = PANEL
    const h = harness({ deferSchedule: true })
    h.graft.start()
    h.graft.state().button!.remove()
    await flush()
    expect(h.pending.length).toBeGreaterThan(0)
    h.graft.stop()
    const before = h.finds()
    for (const fn of h.pending.splice(0)) fn()
    h.graft.sync(true)
    expect(h.finds()).toBe(before)
    expect(document.querySelector(`[${GRAFT_ATTR}]`)).toBeNull()
  })

  it('上限で諦めた後、一定時間が経ったら 1 回だけ再試行する', () => {
    document.body.innerHTML = PANEL
    const h = harness()
    h.graft.start()
    const storm = (): void => {
      for (let i = 0; i < MAX_INSERTS_PER_WINDOW + 2; i++) {
        h.graft.state().button?.remove()
        h.graft.sync(true)
      }
    }
    storm()
    expect(h.graft.state().tripped).toBe(true)
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.ms).toBe(RETRY_AFTER_TRIP_MS)
    h.setNow(100_000)
    h.timers.shift()!.fn()
    expect(h.graft.state().tripped).toBe(false)
    expect(h.graft.state().button).not.toBeNull()
    // 2 回目に諦めたら、もう再試行しない
    storm()
    expect(h.graft.state().tripped).toBe(true)
    expect(h.timers).toHaveLength(0)
    h.graft.stop()
  })
})
