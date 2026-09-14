import type { EngineState, VoiceCordStatus } from './ipc.js'

/**
 * mod 自身の状態の表示用の文言。preload の器（FAB・診断の箱）と UI のポップアウトの
 * 両方が使うので、どちらにも属さないここに置く。
 */

export const DOT_LABEL: Record<EngineState, string> = {
  starting: '起動中',
  searching: 'エンジン生存・音声プロセス未検出',
  attached: 'アタッチ済み',
  failed: 'エンジンが動いていません'
}

/** 状態のうち、ユーザーに理由として見せるべきもの */
export function statusProblems(s: VoiceCordStatus): string[] {
  return [...(s.lastError ? [s.lastError] : []), ...s.degraded.map((d) => `${d.name}: ${d.error}`)]
}
