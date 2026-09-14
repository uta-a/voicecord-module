// hook.js の結合テスト。frida のグローバルだけを最小限に模した箱で**実ファイルをそのまま**
// 走らせ、声の計測が Krisp の onLeave からイベントまで通ることを確かめる。
//
// hook.js は frida の agent なので typecheck の対象外で、これまで実機でしか壊れが分からな
// かった。ここで見ているのは注入そのものではなく、計測の経路(krispEnter → mixFloat →
// calibFrame → calibDone のペイロード)。この経路が壊れると、UI 上は校正できたように見えて
// 推奨音量だけが間違うという、2 人目のリスナー無しでは気付けない形の不具合になる。
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createContext, runInContext } from 'vm'
import { describe, expect, it } from 'vitest'
import { gatedRms } from '../src/shared/loudness.js'

const HOOK_SRC = readFileSync(fileURLToPath(new URL('../src/agent/hook.js', import.meta.url)), 'utf-8')

interface HookMessage {
  ev: string
  [k: string]: unknown
}

interface Harness {
  messages: HookMessage[]
  /** frida がスクリプトを外す直前に呼ぶ rpc.exports.dispose を模す。 */
  dispose: () => void
  /** hook.js の recv("ctrl") へ制御メッセージを流す。 */
  ctrl: (msg: Record<string, unknown>) => void
  /** Krisp の 1 フレーム分(float 版)を流す。samples は [-1,1]。 */
  frame: (samples: Float32Array) => void
  /** 音源をプリロードする(recv("pcm") 経路)。 */
  pcm: (srcId: string, samples: Float32Array) => void
  /** VC 在席監視の 400ms タイマーを 1 回進める。 */
  tick: () => void
  /** Connection::GetStats を 1 回発火させる(VC 通話中は ~1Hz で呼ばれる)。 */
  getStats: (connId: number) => void
  /** SetPTTActive の呼び出し履歴。[active, ...] */
  ptt: number[]
  /** hook 内の Date.now() を進める。 */
  advance: (ms: number) => void
  /** 最後に届いた指定 ev のメッセージ。 */
  last: (ev: string) => HookMessage | undefined
}

// frida のグローバルのうち hook.js が実際に触るものだけを用意する。
// discord_voice.node(送信ゲート)は export を空で返すので、hook.js は error を 1 本出して
// ゲートの設置を諦める — 計測の経路には影響しない。
function loadHook(): Harness {
  const messages: HookMessage[] = []
  const recvHandlers: Record<string, ((msg: unknown, data?: unknown) => void) | undefined> = {}
  let krispOnEnter: ((args: unknown[]) => void) | null = null
  let krispOnLeave: (() => void) | null = null
  let watchdog: (() => void) | null = null

  const FLOAT_EXPORT = { kind: 'KrispNCProcessFloat' }
  // 送信ゲート側(discord_voice.node)。export 名は hook.js が前方一致で探す実物に合わせる。
  const GETSTATS_ADDR = { kind: 'GetStats' }
  const SETPTT_ADDR = { kind: 'SetPTTActive' }
  let gateOnEnter: ((args: unknown[]) => void) | null = null
  const ptt: number[] = []
  let nowMs = 1_000_000

  // Connection* の代役。アドレスの同一性だけを表現する。
  const conn = (id: number): { equals: (o: unknown) => boolean; toString: () => string } => ({
    equals: (o: unknown) => !!o && (o as { id?: number }).id === id,
    toString: () => 'conn#' + id,
    // equals から見えるように id を持たせる
    ...({ id } as object)
  })

  const sandbox = {
    send: (msg: HookMessage) => {
      messages.push(msg)
    },
    recv: (type: string, cb: (msg: unknown, data?: unknown) => void) => {
      recvHandlers[type] = cb
    },
    Process: {
      findModuleByName: (name: string) => {
        if (name === 'discord_krisp.node') {
          return {
            getExportByName: (n: string) => {
              if (n === 'KrispNCProcessFloat') return FLOAT_EXPORT
              throw new Error('not found') // Stable 用の int16 版は無いビルドを模す
            }
          }
        }
        // 送信ゲート側。実物と同じ装飾名の前方一致で解決される。
        return {
          enumerateExports: () => [
            { name: '?GetStats@Connection@voice@discord@@QEAA_NPEAU123@@Z', address: GETSTATS_ADDR },
            {
              name: '?SetPTTActive@Connection@voice@discord@@QEAAX_N00@Z',
              address: SETPTT_ADDR
            }
          ]
        }
      }
    },
    NativeFunction: function (addr: unknown) {
      if (addr !== SETPTT_ADDR) throw new Error('unexpected NativeFunction target')
      return (_conn: unknown, active: number) => {
        ptt.push(active)
      }
    },
    Interceptor: {
      attach: (
        target: unknown,
        cbs: { onEnter?: (args: unknown[]) => void; onLeave?: () => void }
      ) => {
        if (target === FLOAT_EXPORT) {
          krispOnEnter = cbs.onEnter ?? null
          krispOnLeave = cbs.onLeave ?? null
        } else if (target === GETSTATS_ADDR) {
          gateOnEnter = cbs.onEnter ?? null
        }
      }
    },
    // hook 内の時刻。テストから決定的に進められるようにする(Connection* の
    // 拾い直しに時間の上限があるため、その境界を確かめたい)。
    Date: { now: () => nowMs },
    // VC 在席の監視タイマー。自動では回さず、テストから tick() で 1 ティックずつ進める。
    setInterval: (fn: () => void) => {
      watchdog = fn
      return 0
    },
    clearInterval: () => undefined,
    rpc: { exports: {} as { dispose?: () => void } }
  }

  runInContext(HOOK_SRC, createContext(sandbox))

  return {
    messages,
    dispose: () => {
      const fn = sandbox.rpc.exports.dispose
      if (!fn) throw new Error('rpc.exports.dispose が定義されていない')
      fn()
    },
    ctrl: (msg) => {
      const h = recvHandlers['ctrl']
      if (!h) throw new Error('ctrl ハンドラが登録されていない')
      h(msg)
    },
    frame: (samples) => {
      if (!krispOnEnter || !krispOnLeave) throw new Error('Krisp フックが設置されていない')
      // KrispNCProcess[Float](session, in, cnt, out, outCap)。out は読み書きできる箱。
      const bytes = new Uint8Array(samples.buffer.slice(0)).buffer
      const out = {
        readByteArray: (n: number) => bytes.slice(0, n),
        writeByteArray: () => undefined
      }
      const self: Record<string, unknown> = {}
      krispOnEnter.call(self, [null, null, { toInt32: () => samples.length }, out])
      krispOnLeave.call(self)
    },
    pcm: (srcId, samples) => {
      const h = recvHandlers['pcm']
      if (!h) throw new Error('pcm ハンドラが登録されていない')
      h({ sourceId: srcId }, samples.buffer.slice(0))
    },
    tick: () => {
      if (!watchdog) throw new Error('VC 監視タイマーが登録されていない')
      watchdog()
    },
    getStats: (connId) => {
      if (!gateOnEnter) throw new Error('GetStats フックが設置されていない')
      gateOnEnter([conn(connId)])
    },
    ptt,
    advance: (ms) => {
      nowMs += ms
    },
    last: (ev) => [...messages].reverse().find((m) => m.ev === ev)
  }
}

const FRAME = 480
const flat = (amp: number): Float32Array => new Float32Array(FRAME).fill(amp)
const dbfs = (lin: number): number => 20 * Math.log10(lin)

describe('hook.js の声の計測', () => {
  it('フック設置に成功して ready を出す', () => {
    const h = loadHook()
    expect(h.last('ready')).toBeDefined()
    // Krisp の export は見つかっているので、そちらのエラーは出ていないこと。
    const krispErr = h.messages.find(
      (m) => m.ev === 'error' && String(m.msg).includes('Krisp NC export')
    )
    expect(krispErr).toBeUndefined()
  })

  it('予算ぶんのフレームを流すと calibDone とブロック列が届く', () => {
    const h = loadHook()
    h.ctrl({ op: 'calibStart', tag: 'voice', frames: 30 })
    for (let i = 0; i < 30; i++) h.frame(flat(0.05)) // -26.02 dBFS

    const done = h.last('calibDone')
    expect(done).toBeDefined()
    expect(done!.frames).toBe(30)
    const blocks = done!.vBlocks as number[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks).toHaveLength(30)
    expect(dbfs(gatedRms(blocks).rms)).toBeCloseTo(-26.02, 1)
  })

  // 声の測定が「間」の量に左右されないことを、実ファイルを通した状態で確かめる。
  // 相対ゲートは Node 側(shared/loudness.ts)に置いてあるので、hook が無音フレームも
  // 落とさずに渡してこないと成立しない。
  it('無音フレームも落とさずに渡すので、間があっても声の水準が出る', () => {
    const h = loadHook()
    h.ctrl({ op: 'calibStart', tag: 'voice', frames: 60 })
    for (let i = 0; i < 20; i++) h.frame(flat(0.05)) // 発話 -26 dBFS
    for (let i = 0; i < 40; i++) h.frame(flat(0.006)) // 間 -44 dBFS(絶対ゲートは通る)

    const done = h.last('calibDone')!
    const blocks = done.vBlocks as number[]
    expect(blocks).toHaveLength(60)
    // 2 段ゲート後は発話の水準に張り付く。
    expect(dbfs(gatedRms(blocks).rms)).toBeCloseTo(-26.02, 1)
    // hook が出す暫定値(絶対ゲートのみ)は「間」に引かれて低く出る = 相対ゲートの効き目。
    expect(dbfs(done.vRms as number)).toBeLessThan(-28)
  })

  it('calibStop で途中まででも結果を返す', () => {
    const h = loadHook()
    h.ctrl({ op: 'calibStart', tag: 'voice', frames: 1000 })
    for (let i = 0; i < 7; i++) h.frame(flat(0.05))
    h.ctrl({ op: 'calibStop' })

    const done = h.last('calibDone')!
    expect(done.frames).toBe(7)
    expect(done.vBlocks as number[]).toHaveLength(7)
  })

  it('計測していないときは calib イベントを出さない(常時は回さない)', () => {
    const h = loadHook()
    for (let i = 0; i < 10; i++) h.frame(flat(0.05))
    expect(h.last('calib')).toBeUndefined()
    expect(h.last('calibDone')).toBeUndefined()
  })

  it('壊れた frames でも既定へ倒れて動く', () => {
    const h = loadHook()
    h.ctrl({ op: 'calibStart', tag: 'voice', frames: Number.NaN })
    h.frame(flat(0.05))
    h.ctrl({ op: 'calibStop' })
    expect(h.last('calibDone')!.budget).toBe(500)
  })
})

// マイクのミュートや frida VM の一時停滞でも Krisp のフレームは止まる。VC 退出と
// 区別できないため、再生中ボイスの破棄には猶予を置く必要がある。
// 猶予が無かった頃は、再生中にミュートしただけで音がぶつ切りになり行も消えた。
describe('hook.js の VC 在席監視', () => {
  const startPlaying = (h: ReturnType<typeof loadHook>): void => {
    h.pcm('s', new Float32Array(FRAME * 200).fill(0.3))
    h.ctrl({ op: 'play', voiceId: 'v1', srcId: 's', vol: 1.0, loop: false, mode: 'add' })
    h.frame(flat(0.0)) // 1 フレーム流して再生を始動(hb も進む)
  }

  it('フレームが少し途切れただけでは再生中の音を捨てない', () => {
    const h = loadHook()
    startPlaying(h)
    h.tick() // active
    for (let i = 0; i < 6; i++) h.tick() // 停滞 6 ティック(2.4 秒)
    expect(h.last('voiceEnded')).toBeUndefined()
  })

  it('停滞が続けば最終的に後始末する', () => {
    const h = loadHook()
    startPlaying(h)
    h.tick()
    for (let i = 0; i < 7; i++) h.tick() // 停滞 7 ティック(2.8 秒)
    const ended = h.last('voiceEnded')
    expect(ended).toBeDefined()
    expect(ended!.voiceId).toBe('v1')
    expect(h.last('activity')!.playing).toBe(false)
  })

  it('停滞から復帰すれば猶予が数え直される', () => {
    const h = loadHook()
    startPlaying(h)
    h.tick()
    for (let i = 0; i < 6; i++) h.tick()
    h.frame(flat(0.0)) // 復帰(hb が進む)
    h.tick()
    for (let i = 0; i < 6; i++) h.tick()
    expect(h.last('voiceEnded')).toBeUndefined()
  })

  it('vc イベント自体は 1 ティックで出す(Node 側が別途デバウンスする)', () => {
    const h = loadHook()
    h.frame(flat(0.05))
    h.tick() // active=true
    expect(h.last('vc')!.active).toBe(true)
    h.tick() // hb が進まない -> false
    expect(h.last('vc')!.active).toBe(false)
  })
})

// 送信ゲートは「相手に自分の生マイクが流れ続ける」最も危険な状態を作る。VC 退出の誤検知で
// Connection* を捨てた後の扱いを間違えると、状態表示が点滅したり、復帰経路が塞がったりする。
describe('hook.js の送信ゲート', () => {
  const countGate = (h: ReturnType<typeof loadHook>, open: boolean): number =>
    h.messages.filter((m) => m.ev === 'gate' && m.open === open).length
  const countInfo = (h: ReturnType<typeof loadHook>): number =>
    h.messages.filter((m) => m.ev === 'gateInfo').length

  it('Connection* を捕捉したら gateInfo を出し、残骸を必ず閉じる', () => {
    const h = loadHook()
    h.getStats(1)
    expect(countInfo(h)).toBe(1)
    // 前セッションの常時送信が残っている可能性があるので、無条件に 0 を撃つ
    expect(h.ptt).toContain(0)
  })

  it('gateOpen 中は同じ接続へ冪等に再アサートし、gate は 1 回だけ出す', () => {
    const h = loadHook()
    h.getStats(1)
    h.ctrl({ op: 'gateOpen' })
    h.getStats(1)
    h.getStats(1)
    expect(countGate(h, true)).toBe(1) // 状態が変わったときだけ通知される
    expect(h.ptt.filter((v) => v === 1).length).toBeGreaterThanOrEqual(2) // 撃ち直しはしている
  })

  // 回帰: 退出の誤検知でポインタを捨てた後、同じ接続を「新しい接続」と誤認していた。
  // gateApplied が false へ戻るため gate:open が出し直され、UI が 送信中→閉→送信中 と点滅する。
  it('退出を誤検知しても、直後に同じ接続が来たら新接続として扱わない', () => {
    const h = loadHook()
    h.frame(flat(0.05))
    h.tick() // active
    h.getStats(1)
    h.ctrl({ op: 'gateOpen' })
    const infoBefore = countInfo(h)
    const openBefore = countGate(h, true)

    h.tick() // hb が進まない -> 退出と誤検知して gateConn を捨てる
    h.advance(500) // 誤検知は 1 秒以内に GetStats が再開する
    h.getStats(1) // 同じ接続が戻ってきた

    expect(countInfo(h)).toBe(infoBefore) // gateInfo を出し直さない
    expect(countGate(h, true)).toBe(openBefore) // gate:open も出し直さない
  })

  // 逆側: 本当に退出して時間が経った後の同一アドレスは、確保しなおされた別物かもしれない。
  // 誤認すると gateInfo が飛ばず、micTransmit が 'unknown' から復帰する道が塞がる。
  it('時間が経ってからの同一アドレスは新しい接続として扱う', () => {
    const h = loadHook()
    h.frame(flat(0.05))
    h.tick()
    h.getStats(1)
    const infoBefore = countInfo(h)

    h.tick() // 退出
    h.advance(10_000) // 拾い直しの猶予を超える
    h.getStats(1) // たまたま同じアドレスに別の接続

    expect(countInfo(h)).toBe(infoBefore + 1) // 新接続として通知し直す
  })

  it('接続が張り替わったら gateInfo を出し直す', () => {
    const h = loadHook()
    h.getStats(1)
    const before = countInfo(h)
    h.getStats(2)
    expect(countInfo(h)).toBe(before + 1)
  })

  // エンジンが強制終了されると hook ごと消える。消える前に閉じないと、再アタッチした
  // 新しい hook が次の GetStats で閉じるまで、生マイクが流れ続ける。
  it('スクリプトが外される直前に、開いていたゲートを閉じる', () => {
    const h = loadHook()
    h.getStats(1)
    h.ctrl({ op: 'gateOpen' })
    const pttBefore = h.ptt.length
    h.dispose()
    expect(h.ptt.slice(pttBefore)).toEqual([0])
    expect(h.last('gate')!.open).toBe(false)
  })

  it('ゲートを開いていなければ、外されるときに Discord を触らない', () => {
    const h = loadHook()
    h.getStats(1)
    const pttBefore = h.ptt.length
    h.dispose()
    expect(h.ptt.length).toBe(pttBefore)
  })

  it('接続を捕捉する前に外されても落ちない', () => {
    const h = loadHook()
    h.ctrl({ op: 'gateOpen' }) // まだ Connection* が無いので適用されていない
    expect(() => h.dispose()).not.toThrow()
    expect(h.ptt).toEqual([])
  })
})

describe('hook.js のその他', () => {
  it('壊れた frames でも既定へ倒れて動く(重複確認)', () => {
    const h = loadHook()
    h.ctrl({ op: 'calibStart', tag: 'voice', frames: Number.NaN })
    h.frame(flat(0.05))
    // 既定予算(500)で走り続け、途中経過が出せる状態であること。
    h.ctrl({ op: 'calibStop' })
    expect(h.last('calibDone')!.budget).toBe(500)
  })
})
