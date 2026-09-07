/**
 * main（patcher）と renderer（preload の isolated world）の間のチャンネル名。
 *
 * 名前空間は voicecord:。Discord は DISCORD_* / VOICE_*、Vencord は Vencord* を
 * 使うので衝突しない。文字列を直書きせずここに集約し、両側で同じ定数を使う。
 */

export const CH = {
  /** 設定の読み書き */
  getConfig: 'voicecord:getConfig',
  saveConfig: 'voicecord:saveConfig',

  /** エンジン制御。attach は自動が既定なので reattach は手動リトライ用 */
  reattach: 'voicecord:reattach',
  detach: 'voicecord:detach',

  /** サウンドフォルダ */
  scanFolder: 'voicecord:scanFolder',
  chooseFolder: 'voicecord:chooseFolder',
  /** 生ファイルを ArrayBuffer で返す。folder 配下に限定する */
  readSoundFile: 'voicecord:readSoundFile',

  /** renderer でデコードした PCM を engine へ渡す */
  preloadPcm: 'voicecord:preload',

  /** 再生制御 */
  play: 'voicecord:play',
  stop: 'voicecord:stop',
  stopAll: 'voicecord:stopAll',
  setVoiceVolume: 'voicecord:setVoiceVolume',
  setMaster: 'voicecord:setMaster',
  openGate: 'voicecord:openGate',

  /** 音量校正 */
  calibStart: 'voicecord:calibStart',
  calibStop: 'voicecord:calibStop',

  /** 状態取得とイベント購読 */
  getStatus: 'voicecord:getStatus',
  subscribe: 'voicecord:subscribe',

  /** main → renderer のプッシュ */
  event: 'voicecord:event'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]

/** invoke で呼べるチャンネル（event は push 専用なので含まない） */
export const INVOKE_CHANNELS: readonly ChannelName[] = Object.entries(CH)
  .filter(([k]) => k !== 'event')
  .map(([, v]) => v)

/** エンジンの生死。FAB の色に対応する（可視化 2） */
export type EngineState =
  /** 起動中 */
  | 'starting'
  /** 生きているが audio utility をまだ見つけていない（VC に入るまでは正常） */
  | 'searching'
  /** attach 済み */
  | 'attached'
  /** エンジンが落ちた / frida のロードに失敗した */
  | 'failed'

export interface VoiceCordStatus {
  engine: EngineState
  /** attach 先の audio utility プロセス */
  attachedPid: number | null
  discordBuild: string
  discordVersion: string
  /** engine が failed のときの理由。UI にそのまま出す */
  lastError: string | null
  /** patcher のサブシステムのうち起動に失敗したもの */
  degraded: Array<{ name: string; error: string }>
}

/** main → renderer のイベント。M1 では状態変化だけを流す */
export type EngineEvent =
  | { ev: 'status'; status: VoiceCordStatus }
  | { ev: 'log'; level: 'info' | 'warn' | 'error'; message: string }
