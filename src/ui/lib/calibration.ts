// 出力音量の推奨値を出す純関数群。副作用を持たせない(テストフレームワークが無いので、
// 数式を1箇所に集めて目視で追えるようにしておく)。
//
// 相手に届く注入音のレベル(線形・フルスケール 1.0・post-Krisp ドメイン):
//   S(音源固有RMS) × vol(音源別音量) × master × TX_GAIN
// 一括均一化で S × vol = REF(基準レベル)に揃うので、「声に対して R dB」の目標は
//   REF × master × TX_GAIN = 声のRMS × 10^(R/20)
//   → master_dB = 声のdBFS − REF_dBFS − TX_GAIN_dB + R
// 検算: 声 -26 dBFS / REF -14 dBFS / TX_GAIN -12.04 dB / R=0 → master_dB ≒ 0.0
//       = 従来の 100%。校正前後で挙動が飛躍しないことがこの式の妥当性の根拠。
import { MASTER_MAX_DB, MASTER_MIN_DB, TARGET_MAX_DB, TARGET_MIN_DB, TX_GAIN_DB, toDb } from './db'

export const VOL_MAX = 1.5 // 音源別音量の上限(UI の 150% / hook.js の VOL_MAX と一致)

export { TARGET_MIN_DB, TARGET_MAX_DB } from './db'

// 均一化の基準レベル。効果音は RMS が小さい(クレストファクタが高い)ものが多く、
// -14 dBFS 固定だと音源別音量が 150% に張り付いて均一化が成立しないことがある。
export const REF_CHOICES = [
  { db: -20, label: '-20 dBFS', hint: '効果音向け（控えめ）' },
  { db: -17, label: '-17 dBFS', hint: '中間' },
  { db: -14, label: '-14 dBFS', hint: '配信・音楽向け（大きめ）' }
] as const

// 計測が信用できるかの判定。
//
// ok:false にするのは「その値から推奨を出すと壊れた設定になる」ケースだけに限る。
// 声の RMS が 0 に近いと式の上で master → 0(注入音が全く聞こえない)を導くため、そこだけは拒否する。
// 一方、発話率(vN/total)が低いのは単に「間が多かった」だけで、RMS は発話フレームのみを
// 集計しているので値そのものは妥当。ここで弾くと測れているのに適用できず手詰まりになるため、
// 警告に留めて推奨値は出す。
export function validateVoice(m: {
  vRms: number
  vPeak: number
  vN: number
  total: number
}): { ok: boolean; reason?: string; warn?: string } {
  if (m.total <= 0) return { ok: false, reason: '音声フレームを1つも取得できませんでした' }
  if (m.vN <= 0) {
    return {
      ok: false,
      reason: '声を検出できませんでした。マイクのミュートを解除して、もう一度お試しください'
    }
  }
  const db = toDb(m.vRms)
  if (!Number.isFinite(db) || db < -45) {
    return {
      ok: false,
      reason: '声が小さすぎて測れませんでした。マイクに近づくか Discord の入力音量を上げてください'
    }
  }
  if (m.vPeak >= 0.999) {
    return {
      ok: true,
      warn: 'マイク入力が歪んでいます（0 dBFS に張り付いています）。Discord の入力音量を下げてください'
    }
  }
  if (db > -6) {
    return { ok: true, warn: 'マイク入力がかなり大きめです。Discord の入力音量を下げると余裕ができます' }
  }
  if (m.vN / m.total < 0.5) {
    return {
      ok: true,
      warn: '声が途切れていました。「あー」と切らさずに出し続けると、より正確に測れます'
    }
  }
  return { ok: true }
}

// 効果音が声とちょうど同じ大きさで届く送信ゲイン(dB)。**clamp しない**。
// フェーダーの原点・「声との差」の基準点として使う。ここを clamp すると、
// 「声との差」を clamp 済みの原点から測る箇所と、実際の到達レベルから逆算する箇所とで
// 表示が食い違う(実際に +12dB 上限に張り付いた環境で 6dB の矛盾が出た)。
// 到達可能かどうかは targetRange() で別途表現する。
export function voiceMatchDb(voiceRms: number, refDbfs: number): number | null {
  const voiceDb = toDb(voiceRms)
  if (!Number.isFinite(voiceDb)) return null
  return voiceDb - refDbfs - TX_GAIN_DB
}

// 現在の環境で実際に選べる「声との差」の範囲。送信ゲインが 0..4(-∞..+12dB)に収まる
// 範囲に、目標として意味のあるレンジ(-24..+12dB)を重ねたもの。
// 声が大きい環境ほど上側が削られる(効果音をそれ以上持ち上げられない)。
export function targetRange(matchDb: number): { min: number; max: number } | null {
  const min = Math.max(TARGET_MIN_DB, MASTER_MIN_DB - matchDb)
  const max = Math.min(TARGET_MAX_DB, MASTER_MAX_DB - matchDb)
  // 声が極端で相対表示が成立しない(選べる幅が無い)場合は null。呼び出し側は絶対表示へ落とす。
  return max - min < 1 ? null : { min, max }
}

// 現在の送信ゲインにおける「声との差」。実際に相手へ届くレベルから逆算した値で、
// UI に出す差はすべてこの関数を通す(表示箇所ごとに式を書かない)。
export function currentTargetDb(masterDb: number, matchDb: number): number {
  return masterDb - matchDb
}

// 「声との差」の推奨レンジ。
//
// 0 dB は **RMS が声と同じ**という意味であって、「同じ大きさに聞こえる」ではない。
// 声は音節の切れ目や息継ぎで絶えず途切れるのに対し、効果音は鳴っている間ずっと出続ける。
// 同じ RMS なら、連続している側が明らかに大きく感じられる(ラウドネスの評価が
// 瞬時値ではなく持続時間に効くため)。K 特性のような知覚重み付けも掛けていないので、
// 高域寄りの効果音ほどこのズレは開く。
//
// 実測の根拠は 1 環境のみ: 校正で 0 dB(声と同じ)を適用した利用者が、その後フェーダーを
// 手で **ちょうど -6.0 dB** まで下げて常用していた。放送の慣行(効果音や音楽のベッドは
// セリフより 6〜12 dB 下)とも矛盾しない。1 例なので「そこに合わせろ」ではなく
// 「まずここから試す帯」として UI に示す。
export const TARGET_RECOMMENDED_DB = -6
const RECOMMENDED_SPAN_DB = 3 // 推奨点の上下に取る幅

// フェーダーの可動域と重ねた推奨帯。環境によっては可動域から外れる(声が大きいと
// 上側が削られる)ので、重なりが無ければ null を返し、呼び出し側は帯を描かない。
export function recommendedTargetBand(
  min: number,
  max: number
): { min: number; max: number; center: number } | null {
  const lo = Math.max(min, TARGET_RECOMMENDED_DB - RECOMMENDED_SPAN_DB)
  const hi = Math.min(max, TARGET_RECOMMENDED_DB + RECOMMENDED_SPAN_DB)
  if (hi <= lo) return null
  // 中心も可動域へ収める(帯の端に寄ることはあるが、掴めない値は指さない)。
  return { min: lo, max: hi, center: Math.min(hi, Math.max(lo, TARGET_RECOMMENDED_DB)) }
}

// 推奨する送信音量(dB)。範囲外に出た場合はどちら側で頭打ちになったかを返す
// (無言で丸めると「推奨どおりにしたのに合わない」になるため、UI で理由を出す)。
export function recommendMasterDb(
  voiceRms: number,
  refDbfs: number,
  targetDb: number
): { db: number; clampedAt?: 'min' | 'max' } {
  const matchDb = voiceMatchDb(voiceRms, refDbfs)
  if (matchDb === null) return { db: MASTER_MIN_DB, clampedAt: 'min' }
  const raw = matchDb + targetDb
  if (raw > MASTER_MAX_DB) return { db: MASTER_MAX_DB, clampedAt: 'max' }
  if (raw < MASTER_MIN_DB) return { db: MASTER_MIN_DB, clampedAt: 'min' }
  return { db: raw }
}

// 音源単体で許すピーク。mp3 のインターサンプルピークで元から 0dBFS を超えている音源が
// あり(実測で +3.2 dBFS のものまで存在した)、この制約が無いと均一化がそのまま歪みを増幅する。
//
// 0 dBFS にしてあるのは、下流(master × TX_GAIN ≤ 1.0)が減衰しかしないため、音源が
// フルスケール以内なら単体でクリップし得ないから。手持ちの 24 音源での実測比較:
//   上限 -3 dBFS → ピーク制約が 16 件で支配的、基準からのズレ 3.57 dB(均一化が機能しない)
//   上限 -1 dBFS → 11 件、2.59 dB
//   上限  0 dBFS →  5 件、2.31 dB  ← これ以上緩めてもズレは 2.17 dB までしか縮まらない
export const PEAK_CEIL_DBFS = 0

// 音源を基準レベルへ揃えるための音量。
// - ラウドネス(RMS)を基準に合わせる
// - ただしピークが PEAK_CEIL_DBFS を超えない範囲に抑える
// - 150%(VOL_MAX)を超えない
// どれで頭打ちになったかを返す。無言で丸めると「推奨どおりにしたのに揃わない」になる。
export function recommendSourceVolume(
  srcRms: number,
  srcPeak: number,
  refDbfs: number
): { vol: number; clampedAt?: 'max' | 'peak' } {
  const srcDb = toDb(srcRms)
  if (!Number.isFinite(srcDb)) return { vol: 0 }
  const byRms = Math.pow(10, (refDbfs - srcDb) / 20)
  const peakDb = toDb(srcPeak)
  const byPeak = Number.isFinite(peakDb) ? Math.pow(10, (PEAK_CEIL_DBFS - peakDb) / 20) : Infinity
  // 両方の制約を満たせる最大の音量。どちらが先に効いたかではなく、実際に頭打ちに
  // したのがどちらかで理由を決める。上限判定を後に回すと、ピーク制約値が 150% を
  // 超えている音源(= 実際は上限で止まっている)にまで「ピークが高いため控えめ」と
  // 説明してしまう。
  const want = Math.min(byRms, byPeak)
  if (want > VOL_MAX) return { vol: VOL_MAX, clampedAt: 'max' }
  if (byPeak < byRms) {
    // ピーク制約が効いた = クレストファクタが大きい音源。基準ラウドネスには届かないが、
    // 歪ませないことを優先する。
    return { vol: Math.max(0, byPeak), clampedAt: 'peak' }
  }
  return { vol: Math.max(0, byRms) }
}

// フォルダ内のばらつきの中心。基準レベルを「中央値に合わせる」ときに使うと、
// 上下に振り分けられて 150% の頭打ちに当たる音源が最も少なくなる。
export function medianDbfs(rmsList: number[]): number | null {
  const dbs = rmsList.map(toDb).filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
  if (dbs.length === 0) return null
  const mid = dbs.length >> 1
  return dbs.length % 2 ? dbs[mid]! : (dbs[mid - 1]! + dbs[mid]!) / 2
}
