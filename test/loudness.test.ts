// ラウドネス測定の回帰テスト。ここで守っているのは「声と音源を同じ土俵で測る」こと。
// これが崩れると、UI 上は正しく校正できているのに相手側でだけバランスが合わなくなり、
// 実機(= 2 人目のリスナー)無しでは気付けない類の不具合になる。
import { describe, expect, it } from 'vitest'
import { ABS_GATE_DBFS, BLOCK_SAMPLES, gatedRms, measureSamples } from '../src/shared/loudness.js'

const dbfs = (lin: number): number => 20 * Math.log10(lin)
const ms = (dbfsLevel: number): number => Math.pow(10, dbfsLevel / 10) // 振幅 dBFS → 平均二乗

// 絶対ゲートだけで集計した場合の RMS。修正前の挙動そのもので、比較の基準に使う。
function absoluteOnlyRms(blocks: number[]): number {
  const floor = Math.pow(10, ABS_GATE_DBFS / 10)
  const kept = blocks.filter((b) => b > floor)
  if (kept.length === 0) return 0
  return Math.sqrt(kept.reduce((a, b) => a + b, 0) / kept.length)
}

const rep = (value: number, count: number): number[] => Array.from({ length: count }, () => value)

describe('gatedRms', () => {
  it('全ブロックが無音なら 0 を返す(0 除算しない)', () => {
    const r = gatedRms(rep(ms(-80), 100))
    expect(r.rms).toBe(0)
    expect(r.activeBlocks).toBe(0)
    expect(r.gatedBlocks).toBe(0)
  })

  it('空の入力でも NaN を返さない', () => {
    expect(gatedRms([]).rms).toBe(0)
  })

  it('定常信号では相対ゲートが何も落とさない', () => {
    const r = gatedRms(rep(ms(-26), 300))
    expect(dbfs(r.rms)).toBeCloseTo(-26, 6)
    expect(r.gatedBlocks).toBe(300)
  })

  it('NaN / 負値のブロックは集計に入れない', () => {
    const r = gatedRms([ms(-26), NaN, -1, ms(-26)])
    expect(dbfs(r.rms)).toBeCloseTo(-26, 6)
    expect(r.activeBlocks).toBe(2)
  })

  // --- 回帰: 効果音が相手に大きく届きすぎる ---
  // 短いヒット + 長い減衰テールという、効果音のごく普通の形。絶対ゲートだけだと
  // テールまで平均に入って RMS が実際の「鳴っている大きさ」より低く出るため、
  // 均一化(recommendSourceVolume)がその差だけ余計に持ち上げてしまう。
  it('減衰テールの長い音源を過小評価しない', () => {
    const hit = rep(ms(-12), 20) // 200ms のヒット
    const tail = Array.from({ length: 180 }, (_, i) => ms(-20 - i * 0.2)) // 1.8s かけて減衰
    const blocks = [...hit, ...tail]

    const gated = dbfs(gatedRms(blocks).rms)
    const absOnly = dbfs(absoluteOnlyRms(blocks))

    // テールに引きずられた旧来値より、実際に鳴っている大きさへ近づいている。
    // = 均一化がこの差のぶんだけ余計に持ち上げていた。
    expect(gated).toBeGreaterThan(absOnly + 3)
    // ヒット本体(-12 dBFS)から相対ゲートの深さ(-10 dB)以上は離れない。
    // ここが崩れると「大きい部分だけ見る」という相対ゲートの意味が失われている。
    expect(gated).toBeGreaterThan(-22)
  })

  // --- 回帰: 声を取り直すたびに測定値が変わる ---
  // 同じ声量・同じマイクでも、「間」や息継ぎの量は測るたびに変わる。絶対ゲートだけだと
  // それが平均に入るため測定値そのものが動き、推奨される送信音量まで毎回変わってしまう。
  it('声の「間」の量が変わっても測定値がほとんど動かない', () => {
    const speech = rep(ms(-26), 200)
    const pause = ms(-44) // 息継ぎ・暗騒音。-50 dBFS の絶対ゲートは通ってしまう水準

    const takeA = [...speech, ...rep(pause, 10)]
    const takeB = [...speech, ...rep(pause, 100)]

    const gatedDiff = Math.abs(dbfs(gatedRms(takeA).rms) - dbfs(gatedRms(takeB).rms))
    const absDiff = Math.abs(dbfs(absoluteOnlyRms(takeA)) - dbfs(absoluteOnlyRms(takeB)))

    expect(gatedDiff).toBeLessThan(0.1) // 実質再現する
    expect(absDiff).toBeGreaterThan(1.5) // 旧来はこれだけブレていた
  })

  it('「間」の多寡は activeBlocks には残る(発話率の警告に使う)', () => {
    const blocks = [...rep(ms(-26), 100), ...rep(ms(-44), 100)]
    const r = gatedRms(blocks)
    expect(r.activeBlocks).toBe(200) // 絶対ゲートは通る
    expect(r.gatedBlocks).toBe(100) // 相対ゲートで「間」だけ落ちる
  })
})

describe('measureSamples', () => {
  it('ブロック長で割り切れない末尾も 1 ブロックとして測る', () => {
    const r = measureSamples(new Float32Array(BLOCK_SAMPLES + 1).fill(0.5))
    expect(r.totalBlocks).toBe(2)
    expect(r.rms).toBeCloseTo(0.5, 6)
  })

  it('peak はゲートせず全体の最大振幅を返す', () => {
    const samples = new Float32Array(BLOCK_SAMPLES * 2).fill(0.1)
    samples[BLOCK_SAMPLES + 3] = -1.2 // インターサンプルピークで 0 dBFS を超える音源
    expect(measureSamples(samples).peak).toBeCloseTo(1.2, 6)
  })

  it('完全な無音は rms 0 / peak 0', () => {
    const r = measureSamples(new Float32Array(BLOCK_SAMPLES * 3))
    expect(r.rms).toBe(0)
    expect(r.peak).toBe(0)
  })
})
