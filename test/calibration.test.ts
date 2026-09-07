// 「声との差」まわりの純関数のテスト。
import { describe, expect, it } from 'vitest'
import {
  TARGET_RECOMMENDED_DB,
  currentTargetDb,
  recommendMasterDb,
  recommendedTargetBand,
  targetRange,
  voiceMatchDb
} from '../src/ui/lib/calibration.js'
import { MASTER_MAX_DB, MASTER_MIN_DB, TX_GAIN_DB } from '../src/ui/lib/db.js'

describe('recommendedTargetBand', () => {
  it('通常の可動域では推奨点を中心にした帯を返す', () => {
    const b = recommendedTargetBand(-24, 12)
    expect(b).not.toBeNull()
    expect(b!.center).toBe(TARGET_RECOMMENDED_DB)
    expect(b!.min).toBeLessThan(TARGET_RECOMMENDED_DB)
    expect(b!.max).toBeGreaterThan(TARGET_RECOMMENDED_DB)
  })

  it('可動域が推奨帯より狭ければ、その中に収めて返す', () => {
    const b = recommendedTargetBand(-7, -5)
    expect(b).toEqual({ min: -7, max: -5, center: -6 })
  })

  it('可動域が推奨点より上にしか無ければ、掴める値を中心にする', () => {
    const b = recommendedTargetBand(-4, 12)
    expect(b).not.toBeNull()
    expect(b!.min).toBe(-4)
    expect(b!.center).toBe(-4) // 掴めない -6 は指さない
  })

  it('重なりが無ければ null(帯を描かない)', () => {
    expect(recommendedTargetBand(0, 12)).toBeNull()
    expect(recommendedTargetBand(-24, -20)).toBeNull()
  })
})

describe('声との差の往復', () => {
  // 「差」を決めて送信音量を出し、その送信音量から差を逆算すると元に戻ること。
  // ここが崩れると、フェーダーの表示とダイアログの表示が食い違う。
  it('推奨した送信音量から逆算すると元の差に戻る', () => {
    const voiceRms = 0.0456 // -26.8 dBFS
    const ref = -17.2
    for (const target of [-12, -6, -3, 0, 3]) {
      const match = voiceMatchDb(voiceRms, ref)!
      const rec = recommendMasterDb(voiceRms, ref, target)
      expect(rec.clampedAt).toBeUndefined()
      expect(currentTargetDb(rec.db, match)).toBeCloseTo(target, 6)
    }
  })

  it('voiceMatchDb は clamp しない(範囲の表現は targetRange に任せる)', () => {
    // 声が非常に大きい環境では原点が下限を割ることがある。
    const match = voiceMatchDb(0.9, -14)!
    expect(match).toBeCloseTo(20 * Math.log10(0.9) + 14 - TX_GAIN_DB, 6)
    const r = targetRange(match)
    // 可動域は送信ゲインの上限側で削られる
    if (r) expect(r.max).toBeLessThanOrEqual(MASTER_MAX_DB - match)
  })

  it('無音の声からは推奨できないので下限へ倒す', () => {
    const rec = recommendMasterDb(0, -14, 0)
    expect(rec.db).toBe(MASTER_MIN_DB)
    expect(rec.clampedAt).toBe('min')
  })
})
