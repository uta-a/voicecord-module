/**
 * patcher は Discord の main プロセスの中で動く。ここで throw すると Discord ごと
 * 巻き添えにするので、サブシステムを互いに独立させて起動する。
 *
 * 特に UI とエンジンは独立させる。エンジンが死んでいても FAB は出て、パネルを
 * 開けば理由が読める、という状態を保つため（可視化 1・2）。
 *
 * process.on('uncaughtException') は入れない。Discord 自身の Sentry ハンドラを
 * 乗っ取ると、我々起因でない不具合のクラッシュレポートまで壊してしまう。
 */

export interface Subsystem {
  name: string
  run: () => void
}

export interface SubsystemOutcome {
  name: string
  ok: boolean
  error?: string
}

export interface SubsystemLog {
  info: (msg: string) => void
  error: (msg: string, err: unknown) => void
}

/**
 * 順番に起動する。1 つが失敗しても残りは動かす。決して throw しない。
 */
export function runSubsystems(subsystems: readonly Subsystem[], log: SubsystemLog): SubsystemOutcome[] {
  const out: SubsystemOutcome[] = []
  for (const s of subsystems) {
    try {
      s.run()
      out.push({ name: s.name, ok: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.error(`[VoiceCord] サブシステム "${s.name}" の起動に失敗しました`, e)
      out.push({ name: s.name, ok: false, error: message })
    }
  }
  const failed = out.filter((o) => !o.ok)
  if (failed.length === 0) log.info('[VoiceCord] 起動しました')
  else log.info(`[VoiceCord] 一部を無効にして起動しました: ${failed.map((f) => f.name).join(', ')}`)
  return out
}

/** UI に出すための、起動結果の要約 */
export function summarize(outcomes: readonly SubsystemOutcome[]): {
  ok: boolean
  failures: Array<{ name: string; error: string }>
} {
  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ name: o.name, error: o.error ?? 'unknown' }))
  return { ok: failures.length === 0, failures }
}
