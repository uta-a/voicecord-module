import type { Api, SoundItem, SourceStats } from '@shared/types'

// 音源のラウドネス測定。音量調整ダイアログと、メインパネルの「揃える」ボタンの両方から使う。
// どちらも React の寿命とは別に走らせたいので(ボタン側はポップアウトを閉じても最後まで進める)、
// state を持たない関数としてここに置く。

export const SCAN_CONCURRENCY = 3 // ffmpeg 変換が走るので欲張らない

// 測定結果はダイアログを閉じても保持する(Radix は閉じると中身をアンマウントするため、
// これが無いと開き直すたびに全件測り直しになる)。キーは内容指紋なので、ファイルを
// 差し替えれば自動的に測り直しになる。ダイアログとボタンで共有し、片方で測った分は
// もう片方で測り直さない。
const statsCache = new Map<string, SourceStats>()
// 消した時点で進める世代。測定中に「測り直す」が走ると、消す前に始めた測定の結果が
// 後から届いてキャッシュへ古い値を戻してしまうので、取得開始時の世代と一致するときだけ書く。
let cacheGen = 0

/** 「測り直す」用。次の scanSources で全件を実際に測る */
export function clearSourceStatsCache(): void {
  statsCache.clear()
  cacheGen++
}

export interface ScanProgress {
  done: number
  total: number
  sound: SoundItem
  // 失敗した音源では undefined。成功した分だけ呼び出し側で逐次表示に使える。
  stats?: SourceStats
}

export interface ScanResult {
  stats: Map<string, SourceStats> // キーは fp
  failed: number
  // 理由を捨てない。握り潰すと「使えない」としか分からなくなる。文言の日本語化は
  // 表示する側に任せる(ここから store を読むと store → lib → store の循環になる)。
  firstError: { id: string; message: string } | null
}

/**
 * sounds を SCAN_CONCURRENCY 本ずつ測る。1 件の失敗では止めず、残りを測り続ける。
 * signal を取り消すと次の音源へ進まず、取り消し後に届いた結果は進捗にも結果にも入れない。
 */
export async function scanSources(
  sounds: SoundItem[],
  api: Pick<Api, 'sourceStats'>,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<ScanResult> {
  const total = sounds.length
  const queue = [...sounds]
  const stats = new Map<string, SourceStats>()
  let done = 0
  let failed = 0
  let firstError: ScanResult['firstError'] = null
  const alive = (): boolean => !signal?.aborted

  const worker = async (): Promise<void> => {
    for (;;) {
      if (!alive()) return
      const item = queue.shift()
      if (!item) return
      let st: SourceStats | undefined
      try {
        const gen = cacheGen
        st = statsCache.get(item.fp) ?? (await api.sourceStats(item.path))
        if (!alive()) return
        if (gen === cacheGen) statsCache.set(item.fp, st)
        stats.set(item.fp, st)
      } catch (e) {
        if (!alive()) return
        failed++
        if (!firstError) firstError = { id: item.id, message: String(e) }
      }
      done++
      onProgress?.({ done, total, sound: item, stats: st })
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
  return { stats, failed, firstError }
}
