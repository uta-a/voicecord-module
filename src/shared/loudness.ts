// ラウドネス測定のゲーティング。声(hook.js が実測したブロック列)と音源(オフライン解析)の
// 両方がこの関数を通る。「声との差」の式(calibration.ts)は声と音源を同じ土俵で測っている
// ことが前提なので、数え方は 1 箇所にしか置かない。
//
// 2 段ゲート(ITU-R BS.1770 の相対ゲートと同じ考え方):
//   1. 絶対ゲート … -50 dBFS 未満のブロックを落とす(無音・暗騒音)
//   2. 相対ゲート … 1 を通ったブロックの平均から -10 dB 未満のブロックをさらに落とす
//
// 相対ゲートが必要な理由は、症状が声と音源で別々に出るため:
//   - 声: 「あー」の立ち上がり・減衰、息継ぎ、言い直しの量は測るたびに変わる。絶対ゲート
//     だけだとそれらが全部平均に入るので、同じ声・同じマイクでも取り直すたびに値が動く。
//   - 音源: 効果音は減衰テールが長い。-50 dBFS まで拾うと「鳴っている大きさ」よりずっと
//     低い RMS になり、均一化がその分だけ余計に持ち上げる。定常的な「あー」ではこの
//     バイアスがほとんど効かないので、声と音源に系統的なズレが生まれ、結果として
//     「声に合わせたのに効果音だけ相手に大きく届く」になる。
//
// 入力は「ブロックの平均二乗(mean square)」の列。振幅ではなくパワーで持つのは、
// 集計(平均)とゲート判定の両方が二乗領域で完結し、平方根を最後の 1 回で済ませるため。

// 無音とみなす下限。hook.js の CALIB_FLOOR(-50 dBFS)と同じ点。
export const ABS_GATE_DBFS = -50
// 相対ゲートの深さ。BS.1770 の -10 LU に合わせてある。
export const REL_GATE_DB = -10
// 1 ブロックのサンプル数。48kHz/10ms = hook.js が 1 回の onLeave で受け取る量と同じ。
export const BLOCK_SAMPLES = 480

// dB はパワー比なので /10。振幅で持つと二乗の往復が増えるだけで精度は上がらない。
const ABS_FLOOR_MS = Math.pow(10, ABS_GATE_DBFS / 10)
const REL_FACTOR = Math.pow(10, REL_GATE_DB / 10)

// 音源の均一化で目標にする基準ラウドネス(normalizeRefDbfs)の許容範囲。
// 保存時(config.ts)と算出時(音量調整ダイアログ)で同じ値を見る。片方だけだと、極端に
// 静か／大きいフォルダで算出した基準が保存の際に黙って矯正され、再起動の前後で
// 推奨音量が変わる(= 触っていないのに値が変わる)。
export const REF_MIN_DBFS = -40
export const REF_MAX_DBFS = -6

/** 基準ラウドネスを許容範囲へ収める。壊れた値は中庸な既定へ倒す。 */
export function clampRefDbfs(db: number): number {
  if (!Number.isFinite(db)) return -14
  return Math.min(REF_MAX_DBFS, Math.max(REF_MIN_DBFS, db))
}

export interface GatedLoudness {
  /** 相対ゲート後の RMS(線形・フルスケール 1.0)。全ブロックが無音なら 0。 */
  rms: number
  /** 絶対ゲートを通ったブロック数。「鳴っていた/喋っていた割合」はこちらで語る。 */
  activeBlocks: number
  /** 相対ゲートも通ったブロック数。rms の母数。 */
  gatedBlocks: number
}

/** ブロック平均二乗の列から、2 段ゲートを掛けた RMS を出す。 */
export function gatedRms(blockMeanSquares: ArrayLike<number>): GatedLoudness {
  const n = blockMeanSquares.length
  let absSum = 0
  let absN = 0
  for (let i = 0; i < n; i++) {
    const ms = blockMeanSquares[i]!
    // NaN/負値は clamp の比較を素通りするので、ここで確実に落とす
    // (hook.js の num() と同じ理由。壊れた値が RMS を通じて推奨音量まで届く)。
    if (!(ms > ABS_FLOOR_MS)) continue
    absSum += ms
    absN++
  }
  if (absN === 0) return { rms: 0, activeBlocks: 0, gatedBlocks: 0 }

  const threshold = (absSum / absN) * REL_FACTOR
  let relSum = 0
  let relN = 0
  for (let i = 0; i < n; i++) {
    const ms = blockMeanSquares[i]!
    if (!(ms > ABS_FLOOR_MS) || !(ms > threshold)) continue
    relSum += ms
    relN++
  }
  // 最大ブロックは必ず平均以上 = しきい値(平均の 1/10)より上なので relN >= 1 になるが、
  // 浮動小数の縁で 0 になった場合に 0 除算で NaN を返さないよう絶対ゲートの値へ落とす。
  if (relN === 0) return { rms: Math.sqrt(absSum / absN), activeBlocks: absN, gatedBlocks: absN }
  return { rms: Math.sqrt(relSum / relN), activeBlocks: absN, gatedBlocks: relN }
}

export interface SampleLoudness extends GatedLoudness {
  /** 全体の最大振幅。ゲートしない(クリップ判定に使うため)。1.0 を超えることがある。 */
  peak: number
  /** ブロック総数。端数ブロックも 1 つと数える。 */
  totalBlocks: number
}

/**
 * PCM(モノラル・[-1,1] の float)を BLOCK_SAMPLES ごとに区切って測る。
 * 音源のオフライン解析用。声は hook.js が同じブロック長で測った列を送ってくる。
 */
export function measureSamples(samples: ArrayLike<number>): SampleLoudness {
  const n = samples.length
  const blocks: number[] = []
  let peak = 0
  for (let base = 0; base < n; base += BLOCK_SAMPLES) {
    const end = Math.min(base + BLOCK_SAMPLES, n)
    let sum = 0
    for (let i = base; i < end; i++) {
      const v = samples[i]!
      sum += v * v
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
    blocks.push(sum / (end - base))
  }
  return { ...gatedRms(blocks), peak, totalBlocks: blocks.length }
}
