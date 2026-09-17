import type { EngineState } from '../shared/ipc.js'

/**
 * FAB を出すかの判定。
 *
 * M4.5 で VoiceCord の入口は「純正サウンドボードボタンの隣」になった。FAB は
 * **故障したときだけ**出す。平常時に出すと、VC 全画面の「ポップアウト」ボタンなど
 * Discord の操作を塞ぐ（2026-09-14 の回帰確認で踏んだ）。
 *
 * VC に居ないときは何も出さない（純正のボタンが無いところに出さない、という決定）。
 * 「VC に居るのに純正のボタンが見つからない」を故障として扱うため、エンジンの vc 通知を使う。
 * DOM の描画が遅れることはあるので、猶予を置く。
 */

export const ANCHOR_MISSING_GRACE_MS = 3000

export type FabReason =
  | 'ui-failed'
  | 'reinsert-storm'
  | 'engine-problem'
  | 'anchor-missing'

export interface PresenceInput {
  uiMounted: boolean
  grafted: boolean
  tripped: boolean
  inVc: boolean
  /** VC に居るのにアンカーが見つからなくなった時刻。見つかっていれば null */
  missingSince: number | null
  now: number
  engine: EngineState | null
  /** lastError / degraded があるか */
  problems: boolean
}

export type PresenceDecision = { fab: false } | { fab: true; reason: FabReason }

export function decideFab(i: PresenceInput): PresenceDecision {
  // UI が無いなら FAB が唯一の表面。パッチが当たっていることと理由を示す
  if (!i.uiMounted) return { fab: true, reason: 'ui-failed' }
  if (i.tripped) return { fab: true, reason: 'reinsert-storm' }
  if (i.grafted) return { fab: false }
  // 接ぎ木できていない場所でエンジンが壊れているなら、理由を読める入口を残す
  if (i.engine === 'failed' || i.problems) return { fab: true, reason: 'engine-problem' }
  if (i.inVc && i.missingSince !== null && i.now - i.missingSince >= ANCHOR_MISSING_GRACE_MS) {
    return { fab: true, reason: 'anchor-missing' }
  }
  return { fab: false }
}

/**
 * engine のイベントから VC の在否だけを読む。
 * IPC を越えてきた値なので、形を確かめてから使う（active が真偽値でなければ在席と見なさない）。
 */
export function readVcSignal(payload: unknown): 'in' | 'out' | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { ev?: unknown; active?: unknown }
  if (p.ev === 'vc') {
    if (typeof p.active !== 'boolean') return null
    return p.active ? 'in' : 'out'
  }
  if (p.ev === 'engineLost' || p.ev === 'detached') return 'out'
  return null
}

export const FAB_REASON_TEXT: Record<FabReason, string> = {
  'ui-failed': 'VoiceCord の画面を読み込めませんでした',
  'reinsert-storm':
    'サウンドボードの隣にボタンを置き続けられなかったため、画面の端のボタンに切り替えました（Discord の画面構成が変わった可能性があります）',
  'engine-problem': 'VoiceCord のエンジンに問題があります。ボタンを押すと理由を確認できます',
  'anchor-missing':
    'VC 中ですが Discord のサウンドボードボタンが見つかりません。画面の端のボタンから開けます（Discord の更新で画面構成が変わった可能性があります）'
}

/** 予備の方法（tier 3/4）での検出が、この時間続いてから警告する */
export const LOW_TIER_WARN_AFTER_MS = 5000

export interface LowTierInput {
  tier: 1 | 2 | 3 | 4 | null
  /** tier 3/4 になった時刻。tier 1/2 に戻るたびに null */
  since: number | null
  now: number
  /** tier 3/4 になってから、採取結果を新しく受け取ったか */
  refreshed: boolean
  /** 採取役が音声パネルのクラス名を返しているか */
  classesKnown: boolean
  /** 音声パネルのボタン列（採取したクラス名か actionButtons_ 接頭辞）が画面にあるか */
  panelInDom: boolean
}

/**
 * 「予備の方法で見つけています」を警告するか。
 *
 * VC への接続や再読み込みの途中は、通話画面のボタンが音声パネルより先に描画され、
 * 一瞬だけ文言一致（tier 3）で見つかる（Canary 1.0.1177 で約 0.3 秒）。これは Discord の更新ではないので、
 * 一定時間続いたときだけ警告する。また、クラス名は取れているのに音声パネル自体が画面に無い
 * （通話画面だけが出ている）ときも、クラス名の変化ではないので警告しない。
 */
export function shouldWarnLowTier(i: LowTierInput): boolean {
  if (i.tier === null || i.tier <= 2 || i.since === null) return false
  if (i.now - i.since < LOW_TIER_WARN_AFTER_MS) return false
  if (!i.refreshed) return false
  if (i.classesKnown && !i.panelInDom) return false
  return true
}
