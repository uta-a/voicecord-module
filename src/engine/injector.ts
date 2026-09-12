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

/** discord_krisp.node と Krisp NC 処理関数（Float / int16 どちらか）の有無を調べる */
const FIND_JS = `
const m = Process.findModuleByName("discord_krisp.node");
if (!m) { send({found:false}); }
else {
  let hasFn = false;
  try { hasFn = !!m.getExportByName("KrispNCProcessFloat"); } catch(e){}
  if (!hasFn) { try { hasFn = !!m.getExportByName("KrispNCProcess"); } catch(e){} }
  send({found:true, hasFn:hasFn});
}
`

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

/**
 * この PID が audio utility か調べる。
 * attach して検査スクリプトを走らせ、必ず外す（居座ると Discord 側の負荷になる）。
 */
export async function probePid(pid: number): Promise<boolean> {
  const device = await (await loadFrida()).getLocalDevice()
  let session: Session | null = null
  let found = false
  try {
    session = await device.attach(pid)
    const script = await session.createScript(FIND_JS)
    const answered = new Promise<void>((resolve) => {
      script.message.connect((message: Message) => {
        if (message.type === 'send') {
          const p = message.payload as { found?: boolean; hasFn?: boolean }
          found = p.found === true && p.hasFn === true
        }
        resolve()
      })
    })
    await script.load()
    await Promise.race([answered, delay(PROBE_TIMEOUT_MS)])
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
  return found
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
