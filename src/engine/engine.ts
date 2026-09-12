import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngineState } from '../shared/ipc.js'
import type { EngineEvent, PlayReq } from '../shared/types.js'
import { createEngineCore, type EngineCore } from './core.js'
import { Injector, listProcesses, loadFrida, probePid } from './injector.js'
import { createSupervisor, type Supervisor } from './supervisor.js'
import { FridaGate } from './transmit.js'

/**
 * エンジン本体。utilityProcess の子として動く。
 *
 * frida が居るのはこのプロセスだけ。ネイティブが落ちても Discord は生き残り、
 * patcher が 3 秒で起こし直す。だからここでは「落ちない努力」より
 * 「落ちた理由が上に伝わること」を優先する。
 *
 * 親との通信は process.parentPort。構造化複製できる素のデータだけが通る。
 */

const port = process.parentPort

/** hook.js は自分と同じディレクトリ（%LOCALAPPDATA%\VoiceCord\dist）に居る */
const HOOK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.js')

function post(msg: unknown): void {
  try {
    port.postMessage(msg)
  } catch (e) {
    // 親が先に死んでいる。ここで投げても誰も受け取らないのでログだけ
    console.error('[engine] 親へ送れませんでした', e)
  }
}

const emit = (payload: EngineEvent): void => post({ t: 'ev', payload })

let lastState: EngineState = 'starting'
/** 直近に実測した注入レート。attach のたびに測り直す */
let lastRate: { sampleRate: number | null; frameSamples: number | null } = {
  sampleRate: null,
  frameSamples: null
}
const setState = (state: EngineState, attachedPid: number | null, error: string | null): void => {
  lastState = state
  if (attachedPid === null) lastRate = { sampleRate: null, frameSamples: null }
  post({ t: 'state', state, attachedPid, error, ...lastRate })
}

const inj = new Injector()
const gate = new FridaGate(inj, {
  // ゲートの状態遷移はユーザー向けの文ではなく内部ログ。status で流すと
  // renderer が全部トーストするため、再生のたびに英語が点滅する
  onStatus: (m) => emit({ ev: 'log', msg: m })
})
let core: EngineCore | null = null
let supervisor: Supervisor | null = null

/**
 * レートの追随。
 *
 * 2 つの理由で「一度測って終わり」にできない。
 *
 *   1. krisp がロードされた瞬間に検査すると、まだ 1 フレームも処理しておらず
 *      0 回で返る。その場合レートが永久に不明のままになり、48000 で鳴らして
 *      「遅くて低い」になる（実機で踏んだ）
 *   2. **接続中にレートが変わる。** 音声品質（Nitro / チャンネルのビットレート）で
 *      フレーム長が 320 と 480 の間で動く。変わった瞬間にピッチと速度がズレるが、
 *      音でしか分からないので気付きにくい（実機で踏んだ）
 *
 * したがって、取れるまで短い間隔で測り直し、取れた後も定期的に見張る。
 */
const RATE_RETRY_MS = 2_000
const RATE_RETRY_MAX = 15
/** 取れた後の見張り間隔。品質変更に追随するため */
const RATE_RECHECK_MS = 30_000
let rateRetry: NodeJS.Timeout | null = null

function cancelRateRetry(): void {
  if (rateRetry === null) return
  clearTimeout(rateRetry)
  rateRetry = null
}

/**
 * レートを測り直す予約。
 * left は「まだ一度も取れていない」ときの残り試行回数。取れた後は見張りに移る。
 */
function scheduleRateRetry(pid: number, left: number): void {
  cancelRateRetry()
  const known = lastRate.sampleRate !== null
  if (!known && left <= 0) {
    emit({
      ev: 'log',
      level: 'warn',
      msg: '注入レートを測れませんでした。48000Hz として扱います。音が遅い / 低い場合は再アタッチしてください'
    })
    return
  }
  rateRetry = setTimeout(
    () => {
      rateRetry = null
      void probePid(pid).then(
        (p) => {
          // 測っている間に別の相手へ移っていたら捨てる
          if (supervisor?.attachedPid() !== pid) return
          if (p.sampleRate === null) {
            // 鳴っていないだけかもしれない。既知の値は保ったまま次を待つ
            scheduleRateRetry(pid, known ? RATE_RETRY_MAX : left - 1)
            return
          }
          if (p.sampleRate !== lastRate.sampleRate) {
            const before = lastRate.sampleRate
            lastRate = { sampleRate: p.sampleRate, frameSamples: p.frameSamples }
            setState('attached', pid, null)
            emit({
              ev: 'log',
              level: 'info',
              msg:
                before === null
                  ? `注入レートを測りました: ${p.sampleRate} Hz（${p.frameSamples} サンプル/フレーム）`
                  : `注入レートが変わりました: ${before} Hz → ${p.sampleRate} Hz（音声品質の変更）`
            })
          }
          scheduleRateRetry(pid, RATE_RETRY_MAX)
        },
        () => scheduleRateRetry(pid, known ? RATE_RETRY_MAX : left - 1)
      )
    },
    known ? RATE_RECHECK_MS : RATE_RETRY_MS
  )
}

/**
 * 要求の処理。ここに無いチャンネルは patcher 側の担当なので、
 * 届いた時点で配線の誤り。無言で undefined を返さず理由を返す。
 */
type Handler = (args: unknown[]) => unknown

function need(): EngineCore {
  if (core === null) throw new Error('エンジンが初期化されていません')
  return core
}

const handlers: Record<string, Handler> = {
  'voicecord:detach': async () => {
    // 手動で離す。以後この起動では自動で噛み直さない
    // （噛み直したいときは patcher 側の再アタッチ＝エンジン再起動を使う）
    supervisor?.stop()
    gate.revertNow()
    await inj.detach()
    need().resetSession()
    setState('searching', null, null)
  },

  'voicecord:preload': ([srcId, fp, pcm]) => {
    if (typeof srcId !== 'string' || typeof fp !== 'string') {
      throw new Error('音源の指定が不正です')
    }
    if (!(pcm instanceof ArrayBuffer)) throw new Error('PCM が届いていません')
    return need().preloadPcm(srcId, fp, Buffer.from(pcm))
  },

  'voicecord:play': ([req]) => need().play(req as PlayReq),
  'voicecord:stop': ([vid]) => need().stop(String(vid)),
  'voicecord:stopAll': () => need().stopAll(),
  'voicecord:setVoiceVolume': ([vid, vol]) => need().setVoiceVolume(String(vid), Number(vol)),
  'voicecord:setMaster': ([v]) => need().setMaster(Number(v)),
  'voicecord:openGate': ([guardMs]) => need().preOpenGate(Number(guardMs) || 1500),
  'voicecord:calibStart': ([tag, frames]) => need().calibStart(String(tag), Number(frames)),
  'voicecord:calibStop': () => need().calibStop()
}

port.on('message', (e) => {
  const msg = (e as { data?: unknown }).data
  if (typeof msg !== 'object' || msg === null) return
  const m = msg as { t?: string; id?: number; ch?: string; args?: unknown[] }
  if (m.t !== 'req' || typeof m.id !== 'number' || typeof m.ch !== 'string') return
  const fn = handlers[m.ch]
  if (fn === undefined) {
    post({ t: 'res', id: m.id, ok: false, error: `${m.ch} はエンジンの担当ではありません（配線の誤り）` })
    return
  }
  void Promise.resolve()
    .then(() => fn(Array.isArray(m.args) ? m.args : []))
    .then(
      (value) => post({ t: 'res', id: m.id, ok: true, value }),
      (err: unknown) =>
        post({ t: 'res', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
})

/**
 * 後始末。ゲート復帰 4 層の 1 層目。
 *
 * 親が消えた／終了を指示されたとき、送信を開いたまま死なない。
 * ただし真の保証は hook.js 側にある（新しい Connection* を捕まえた時点で
 * 無条件に SetPTTActive(0) を撃つ）ので、ここが間に合わなくても最長 5 秒で閉じる。
 */
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    supervisor?.stop()
  } catch {
    // 監視が止められなくても後始末は続ける
  }
  try {
    gate.revertNow()
  } catch {
    // 既に切れていれば no-op になる
  }
  process.exit(0)
}

// 'close' は Electron の ParentPort が持つが、型定義が 'message' しか
// 宣言していないので型だけ緩める（M2 のスタブでも同じ経路で動いている）
;(port as unknown as { on(ev: 'close', fn: () => void): void }).on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGBREAK', shutdown)

async function main(): Promise<void> {
  setState('starting', null, null)

  // frida をここで一度だけ読む。失敗の理由を状態として上へ返したいので、
  // モジュールの静的 import にはしていない（injector.ts のコメント参照）
  try {
    await loadFrida()
  } catch (e) {
    // **終了しない。** 終了すると patcher が「コード N で終了しました」に
    // 上書きしてしまい、AV に隔離された等の本当の理由が読めなくなる。
    // 生きたまま理由を持ち続け、再アタッチ（エンジン再起動）で再試行させる
    setState(
      'failed',
      null,
      `frida を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`
    )
    console.error('[engine] frida のロードに失敗しました', e)
    return
  }

  core = createEngineCore({ inj, gate, emit })
  inj.onEvent = (p) => core?.onHookEvent(p)

  supervisor = createSupervisor({
    listProcesses,
    probe: probePid,
    attach: async (pid, probe) => {
      await inj.attach(pid, HOOK_PATH)
      core?.resetSession()
      // 状態より先に入れる。setState が読むので順序が要る
      lastRate = { sampleRate: probe.sampleRate, frameSamples: probe.frameSamples }
      return true
    },
    // 列挙結果には必ず自分自身が混ざる。除外しないと自分に噛みに行く
    selfPid: process.pid,
    // audio utility の親は Discord の browser プロセス＝我々の親でもある
    parentPid: process.ppid,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    now: () => Date.now(),
    onLog: (level, message) => emit({ ev: 'log', level, msg: message }),
    onAttached: (pid, probe) => {
      lastRate = { sampleRate: probe.sampleRate, frameSamples: probe.frameSamples }
      setState('attached', pid, null)
      // 取れていなければ測り直し、取れていても見張りに入る（品質変更への追随）
      scheduleRateRetry(pid, RATE_RETRY_MAX)
    },
    onLost: () => {
      cancelRateRetry()
      setState('searching', null, null)
    }
  })

  inj.onDetached = () => supervisor?.onDetached()

  // 「生きているが audio utility をまだ見つけていない」。VC に入るまではこれが正常
  setState('searching', null, null)
  supervisor.start()

  console.log(`[engine] 起動しました（pid ${process.pid} / 親 ${process.ppid}）`)
}

void main().catch((e: unknown) => {
  setState('failed', null, `エンジンの初期化に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
  console.error('[engine] 初期化に失敗しました', e)
})

// 型だけ使う（lastState は将来の診断用に保持している）
export type { EngineState }
export const currentState = (): EngineState => lastState
