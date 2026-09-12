import { readFileSync } from 'node:fs'
import type { Message, Script, Session } from 'frida'
import type { EngineEvent } from '../shared/types.js'
import type { ProcessInfo } from './supervisor.js'

/**
 * frida と話す層。ここだけがネイティブに触る。
 *
 * 移植元（desktop/src/main/engine/injector.ts）とほぼ同じ。
 * Discord の main プロセスには載らないので、ここが落ちても Discord は生き残る。
 *
 * frida は**静的 import しない**。出力は ESM なので静的 import でも動くが、
 * それだと frida_binding.node が無い / AV に隔離されたときにモジュールの
 * 読み込みごと落ち、エンジンが「理由の分からない即死」になる。遅延させて
 * おけば、起動時に一度だけ捕まえて理由を状態として上へ返せる（M3 の完了判定 5）。
 */

let fridaMod: typeof import('frida') | null = null

/** frida を読む。失敗したら理由をそのまま投げる（呼び出し側が状態に出す） */
export async function loadFrida(): Promise<typeof import('frida')> {
  if (fridaMod === null) fridaMod = await import('frida')
  return fridaMod
}

/**
 * discord_krisp.node の有無と、**1 フレームのサンプル数と発火レート**を測る。
 *
 * レートを実測するのは、旧解析の「48kHz / 480 サンプル」が今日の Canary では
 * 320 サンプル / 100Hz（＝32kHz）になっていたため。決め打ちにすると、
 * Discord がレートを変えた瞬間に「遅くて低い音が鳴る」という、動いているようで
 * 動いていない壊れ方をする（実機で踏んだ）。
 */
const FIND_JS = `
const m = Process.findModuleByName("discord_krisp.node");
if (!m) { send({found:false}); }
else {
  let fn = null;
  try { fn = m.getExportByName("KrispNCProcessFloat"); } catch(e){}
  if (!fn) { try { fn = m.getExportByName("KrispNCProcess"); } catch(e){} }
  if (!fn) { send({found:false}); }
  else {
    // cnt の出現回数を数える。フレーム長が揺れる実装でも最頻値を拾えるようにする
    var counts = {}, calls = 0, t0 = 0;
    Interceptor.attach(fn, { onEnter: function(a) {
      if (t0 === 0) t0 = Date.now();
      var c = a[2].toInt32();
      if (c > 0 && c <= 4096) { counts[c] = (counts[c] || 0) + 1; calls++; }
    }});
    setTimeout(function(){
      var elapsed = t0 === 0 ? 0 : (Date.now() - t0);
      send({ found: true, calls: calls, elapsedMs: elapsed, counts: counts });
    }, MEASURE_MS);
  }
}
`

/** 発火レートを測る窓。短すぎると端数で誤差が出る */
const MEASURE_MS = 700

/** 検査スクリプトの返事を待つ上限。返らないプロセスで居座らない */
const PROBE_TIMEOUT_MS = 1500

/** プロセス一覧。attach しないので安い */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const frida = await loadFrida()
  const device = await frida.getLocalDevice()
  // metadata スコープでないと ppid が付いてこない（Windows で実測）。
  // Scope は TS の enum なので、遅延ロードしたモジュールから取る
  const procs = await device.enumerateProcesses({ scope: frida.Scope.Metadata })
  return procs.map((p) => ({
    pid: p.pid,
    name: p.name,
    ppid: ppidOf(p.parameters)
  }))
}

function ppidOf(params: unknown): number | null {
  if (typeof params !== 'object' || params === null) return null
  const v = (params as { ppid?: unknown }).ppid
  return typeof v === 'number' ? v : null
}

export interface KrispProbe {
  /** krisp を持ち、処理関数が居るか */
  found: boolean
  /** 1 フレームのサンプル数（最頻値）。測れなければ null */
  frameSamples: number | null
  /** 1 秒あたりに消費されるサンプル数。測れなければ null */
  sampleRate: number | null
}

/** よくあるレート。実測がこの近傍なら丸める（端数のまま扱うと診断が読みにくい） */
const KNOWN_RATES = [8000, 16000, 24000, 32000, 44100, 48000]
/** 丸めを許す幅 */
const SNAP_TOLERANCE = 0.05

export function snapRate(raw: number): number {
  for (const r of KNOWN_RATES) {
    if (Math.abs(raw - r) / r <= SNAP_TOLERANCE) return r
  }
  return Math.round(raw)
}

/**
 * この PID が注入先かを調べ、ついでにフレーム長とレートを測る。
 * attach して検査スクリプトを走らせ、必ず外す（居座ると Discord 側の負荷になる）。
 */
export async function probePid(pid: number): Promise<KrispProbe> {
  const device = await (await loadFrida()).getLocalDevice()
  let session: Session | null = null
  let result: KrispProbe = { found: false, frameSamples: null, sampleRate: null }
  try {
    session = await device.attach(pid)
    const script = await session.createScript(FIND_JS.replace('MEASURE_MS', String(MEASURE_MS)))
    const answered = new Promise<void>((resolve) => {
      script.message.connect((message: Message) => {
        if (message.type === 'send') result = interpret(message.payload)
        resolve()
      })
    })
    await script.load()
    await Promise.race([answered, delay(MEASURE_MS + PROBE_TIMEOUT_MS)])
    try {
      await script.unload()
    } catch {
      // 既に消えていても構わない
    }
  } finally {
    if (session !== null) {
      try {
        await session.detach()
      } catch {
        // 既に切れていても構わない
      }
    }
  }
  return result
}

/** 検査スクリプトの返事を KrispProbe へ。測れなかった項目は null のままにする */
export function interpret(payload: unknown): KrispProbe {
  const p = payload as { found?: boolean; calls?: number; elapsedMs?: number; counts?: Record<string, number> }
  if (p?.found !== true) return { found: false, frameSamples: null, sampleRate: null }
  const counts = p.counts ?? {}
  let frameSamples: number | null = null
  let best = 0
  for (const [k, n] of Object.entries(counts)) {
    if (n > best) {
      best = n
      frameSamples = Number(k)
    }
  }
  // krisp は載っているが鳴っていない（VC に入っていない等）。found は返すが
  // レートは測れない。呼び出し側は既定値で進み、次の attach で測り直す
  const calls = p.calls ?? 0
  const elapsed = p.elapsedMs ?? 0
  if (frameSamples === null || calls <= 1 || elapsed <= 0) {
    return { found: true, frameSamples, sampleRate: null }
  }
  // 最初の呼び出しで計測を始めるので、区間に含まれる呼び出しは calls - 1 回ぶん
  const hz = ((calls - 1) * 1000) / elapsed
  return { found: true, frameSamples, sampleRate: snapRate(frameSamples * hz) }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class Injector {
  private session: Session | null = null
  private script: Script | null = null
  private voiceSeq = 1

  onEvent: ((p: EngineEvent) => void) | null = null
  /** frida のセッションが切れた。supervisor へ知らせる */
  onDetached: (() => void) | null = null

  get attached(): boolean {
    return this.script !== null
  }

  async attach(pid: number, hookPath: string): Promise<void> {
    const device = await (await loadFrida()).getLocalDevice()
    const session = await device.attach(pid)
    const source = readFileSync(hookPath, 'utf-8')
    const script = await session.createScript(source)
    script.message.connect((message: Message) => {
      if (message.type === 'send') {
        this.onEvent?.(message.payload as EngineEvent)
      } else {
        this.onEvent?.({ ev: 'error', msg: JSON.stringify(message) })
      }
    })
    // Discord 終了 / プロセス消滅 / frida 切断を検知する。自発 detach では
    // 先に this.session を null 化するため、ここでの取り違え通知を避けられる
    session.detached.connect((reason) => {
      if (this.session !== session) return
      this.session = null
      this.script = null
      this.onEvent?.({ ev: 'detached', reason: String(reason) })
      this.onDetached?.()
    })
    await script.load()
    this.session = session
    this.script = script
  }

  async detach(): Promise<void> {
    const script = this.script
    const session = this.session
    this.script = null
    this.session = null
    try {
      if (script) await script.unload()
    } catch {
      // 既に消えていても構わない
    }
    try {
      if (session) await session.detach()
    } catch {
      // 既に切れていても構わない
    }
  }

  private post(message: unknown, data?: Buffer): void {
    if (this.script === null) return
    this.script.post(message, data ?? null)
  }

  // ---- 音源プリロード ----
  preload(srcId: string, pcm: Buffer): void {
    this.post({ type: 'pcm', sourceId: srcId }, pcm)
  }
  unload(srcId: string): void {
    this.post({ type: 'ctrl', op: 'unload', srcId })
  }

  // ---- 再生制御 ----
  // 常に単発・add（声に重ねる）。loop / replace は UI から外してある
  play(srcId: string, vol = 1.0, loop = false, mode = 'add'): string | null {
    if (this.script === null) return null
    const vid = `v${this.voiceSeq++}`
    this.post({ type: 'ctrl', op: 'play', voiceId: vid, srcId, vol, loop, mode })
    return vid
  }
  stop(voiceId: string): void {
    this.post({ type: 'ctrl', op: 'stop', voiceId })
  }
  stopAll(): void {
    this.post({ type: 'ctrl', op: 'stopAll' })
  }
  setVolume(voiceId: string, vol: number): void {
    this.post({ type: 'ctrl', op: 'setVolume', voiceId, vol })
  }
  setMaster(vol: number): void {
    this.post({ type: 'ctrl', op: 'setMaster', vol })
  }

  // ---- 出力レベル計測 ----
  // frames は hook 側のフレーム予算（48kHz / 480 サンプルなので 100 フレーム ≒ 1 秒）
  calibStart(tag: string, frames: number): void {
    this.post({ type: 'ctrl', op: 'calibStart', tag, frames })
  }
  calibStop(): void {
    this.post({ type: 'ctrl', op: 'calibStop' })
  }

  // ---- 送信ゲート ----
  gateOpen(): void {
    this.post({ type: 'ctrl', op: 'gateOpen' })
  }
  gateClose(): void {
    this.post({ type: 'ctrl', op: 'gateClose' })
  }
  /** 強制送信フラグのみ解除（applyGate を呼ばず、解放済み Connection* を触らない） */
  gateReset(): void {
    this.post({ type: 'ctrl', op: 'gateReset' })
  }
}
