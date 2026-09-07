// 線形ゲイン ↔ dB の変換と表示フォーマット。副作用を持たない純関数だけを置く
// (このリポジトリにはテストフレームワークが無いため、目視で検証できる形に保つ)。

// 送信音量(master)のフェーダー範囲。
// 0 dB = 従来の 100%(線形 1.0)。上限 +12 dB は hook.js の TX_GAIN(0.25 ≒ -12dB)を
// ちょうど打ち消す点で、「送信ヘッドルームによる減衰がゼロ」を意味する。
// これ以上は上げられない代わりに master*TX_GAIN <= 1.0 が保たれ、フルスケール以内の音源を
// 1 本だけ 100% 以下で鳴らす限り注入音は歪まない(音源別音量が 100% 超、または同時再生では
// clamp が効きうる)。
export const MASTER_MAX_DB = 12
// これ以下は無音(線形 0)として扱う。フェーダーの下端。
export const MASTER_MIN_DB = -60
// hook.js の TX_GAIN = 0.25 のミラー。20*log10(0.25)。片方を変えたら必ず両方直すこと。
export const TX_GAIN_DB = -12.04

// 声に対して効果音を何 dB にするか。ユーザーがスライダーで自由に決める。
// 下限は「かろうじて聞こえる」、上限は「声を明確に押しのける」あたり。
// 実際に選べる範囲は送信ゲインの上限にも縛られる(calibration.ts の targetRange)。
export const TARGET_MIN_DB = -24
export const TARGET_MAX_DB = 12

// 線形ゲイン → dB。0(無音)は -Infinity を返す。
export function toDb(lin: number): number {
  if (!Number.isFinite(lin) || lin <= 0) return -Infinity
  return 20 * Math.log10(lin)
}

// dB → 線形ゲイン。MASTER_MIN_DB 以下は完全な無音(0)に落とす。
export function toLinear(db: number): number {
  if (!Number.isFinite(db) || db <= MASTER_MIN_DB) return 0
  return Math.pow(10, db / 20)
}

// フェーダーのつまみ位置。実値が範囲外でも枠内に収める(表示値は実値のまま)。
export function clampDb(db: number): number {
  if (!Number.isFinite(db)) return MASTER_MIN_DB
  return Math.min(MASTER_MAX_DB, Math.max(MASTER_MIN_DB, db))
}

// "+3.5 dB" / "-12.0 dB" / "-∞ dB"。符号を必ず付けてミキサーのフェーダー表記に揃える。
export function fmtDb(db: number): string {
  if (!Number.isFinite(db)) return '-∞ dB'
  const v = Math.abs(db) < 0.05 ? 0 : db // -0.0 dB を避ける
  return `${v > 0 ? '+' : v < 0 ? '-' : '±'}${Math.abs(v).toFixed(1)} dB`
}

// 測定レベルの表記。フルスケール基準なので符号は付けない(常に 0 以下)。
export function fmtDbfs(lin: number): string {
  const db = toDb(lin)
  if (!Number.isFinite(db)) return '-∞ dBFS'
  return `${db.toFixed(1)} dBFS`
}

// dBFS を 0..1 のメーター幅へ。MASTER_MIN_DB(-60) を左端、0 dBFS を右端とする線形マップ。
export function meterRatio(lin: number): number {
  const db = toDb(lin)
  if (!Number.isFinite(db)) return 0
  return Math.min(1, Math.max(0, (db - MASTER_MIN_DB) / -MASTER_MIN_DB))
}
