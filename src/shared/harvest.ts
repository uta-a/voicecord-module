/**
 * メインワールドの採取役（src/mainworld）と preload（isolated world）の間の取り決め。
 *
 * 採取役は Discord の webpack から「音声パネルのボタンの CSS モジュール」を引き、
 * クラス名だけを文字列で返す。クラス名はビルドごとにハッシュが変わるので DOM から
 * 推測するより確実だが、メインワールドは Discord のページと同じ世界なので、
 * **届いた値は信用しない**。ページ上の任意のスクリプトが同じイベントを投げられる。
 *
 * だから受け側では「クラス名として妥当な文字列か」だけを見て、それ以外は捨てる。
 * 値は className とセレクタにしか使わない（HTML として解釈する経路を作らない）。
 * 引けなかった理由も自由文では受け取らず、既知のコードに限る（画面には固定の文言を出す）。
 */

/** preload → 採取役。「もう一度引き直して」 */
export const HARVEST_REQUEST_EVENT = 'voicecord:harvest-request'
/** 採取役 → preload。detail は JSON 文字列（ワールドを跨ぐのでオブジェクトは渡さない） */
export const HARVEST_RESULT_EVENT = 'voicecord:harvest'

/** 引いてくる CSS モジュールのキー。使うのは音声パネルのボタン列のクラスだけ */
export const ACTION_BUTTON_KEYS = ['actionButtons'] as const

export type ActionButtonKey = (typeof ACTION_BUTTON_KEYS)[number]
export type ActionButtonClasses = Partial<Record<ActionButtonKey, string>>

export type HarvestSource = 'vencord' | 'webpack' | 'none'

/** 引けなかった理由。自由文ではなくコードで運ぶ */
export const HARVEST_CODES = [
  'no-webpack',
  'push-failed',
  'no-require',
  'module-not-loaded',
  'exception'
] as const

export type HarvestCode = (typeof HARVEST_CODES)[number] | 'unknown'

/** 画面に出す文言。届いたコードに対応が無ければ unknown の文言になる */
export const HARVEST_CODE_TEXT: Record<HarvestCode, string> = {
  'no-webpack': 'Discord の webpack が見つかりません',
  'push-failed': 'webpack に問い合わせられませんでした',
  'no-require': 'webpack の require を受け取れませんでした',
  'module-not-loaded': '音声パネルのボタンの CSS がまだ読み込まれていません',
  exception: '採取中に例外が起きました',
  unknown: '理由不明'
}

export interface HarvestResult {
  source: HarvestSource
  classes: ActionButtonClasses | null
  code: HarvestCode | null
}

/** CSS モジュールのクラス名 1 語。webpack の命名（actionButtons_e131a9）に収まる範囲だけ通す */
const CLASS_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/

/** 空白区切りのクラス列を検証する。1 語でも妥当でなければ全体を捨てる */
export function sanitizeClassList(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const tokens = v.trim().split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0 || tokens.length > 8) return null
  if (!tokens.every((t) => CLASS_TOKEN.test(t))) return null
  return tokens.join(' ')
}

function parseCode(v: unknown): HarvestCode | null {
  if (v === null || v === undefined) return null
  return (HARVEST_CODES as readonly unknown[]).includes(v) ? (v as HarvestCode) : 'unknown'
}

/** 採取役から届いた detail を検証して取り込む。形が違えば null */
export function parseHarvestDetail(detail: unknown): HarvestResult | null {
  if (typeof detail !== 'string' || detail.length > 4096) return null
  let raw: unknown
  try {
    raw = JSON.parse(detail)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { source?: unknown; classes?: unknown; code?: unknown }
  const source: HarvestSource =
    r.source === 'vencord' || r.source === 'webpack' ? r.source : 'none'
  let classes: ActionButtonClasses | null = null
  if (typeof r.classes === 'object' && r.classes !== null) {
    const out: ActionButtonClasses = {}
    for (const k of ACTION_BUTTON_KEYS) {
      const s = sanitizeClassList((r.classes as Record<string, unknown>)[k])
      if (s !== null) out[k] = s
    }
    // 列そのものが取れていなければ使い道が無い
    classes = out.actionButtons !== undefined ? out : null
  }
  return { source, classes, code: parseCode(r.code) }
}
