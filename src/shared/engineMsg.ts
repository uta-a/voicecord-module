import type { EngineState } from './ipc.js'
import type { EngineEvent as RawEngineEvent } from './types.js'

/**
 * patcher（Discord の main プロセス）と engine（utilityProcess の子）の間の電文。
 *
 * frida は engine 側にしか居ない。ネイティブが落ちても Discord が巻き添えに
 * ならないように、両者はプロセス境界で隔てられている。したがってここを通るのは
 * 構造化複製できる素のデータだけで、関数もハンドルも渡せない。
 *
 * PCM のようなバイナリは `postMessage` の第 2 引数（transfer）に載せるので、
 * この電文の本体には含めない。
 */

/** patcher → engine。invoke の中身をそのまま転送する */
export interface EngineRequest {
  t: 'req'
  /** 応答を突き合わせる連番。engine 側は必ず同じ id で返す */
  id: number
  /** CH の値（'voicecord:play' など） */
  ch: string
  args: unknown[]
}

/** engine → patcher。要求への応答 */
export interface EngineReply {
  t: 'res'
  id: number
  ok: boolean
  value?: unknown
  /** ok:false のときの理由。UI にそのまま出る */
  error?: string
}

/** engine → patcher。hook.js 由来のイベントを素の形のまま運ぶ */
export interface EngineEmit {
  t: 'ev'
  payload: RawEngineEvent
}

/**
 * engine → patcher。エンジン自身の生死。
 *
 * プロセスの生死（exit）は patcher が直接見るが、「生きているが audio utility を
 * まだ見つけていない」「attach した」は engine にしか分からない。
 */
export interface EngineStateMsg {
  t: 'state'
  state: EngineState
  attachedPid: number | null
  /** 実測した注入レート。測れなければ null */
  sampleRate?: number | null
  frameSamples?: number | null
  error: string | null
}

export type ToEngine = EngineRequest
export type FromEngine = EngineReply | EngineEmit | EngineStateMsg

/** 子プロセスから来た値を素通しせず、形を確かめてから使う */
export function isFromEngine(v: unknown): v is FromEngine {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { t?: unknown }).t
  if (t === 'res') return typeof (v as EngineReply).id === 'number'
  if (t === 'ev') {
    const p = (v as EngineEmit).payload
    return typeof p === 'object' && p !== null && typeof (p as RawEngineEvent).ev === 'string'
  }
  if (t === 'state') {
    const s = (v as EngineStateMsg).state
    return s === 'starting' || s === 'searching' || s === 'attached' || s === 'failed'
  }
  return false
}
