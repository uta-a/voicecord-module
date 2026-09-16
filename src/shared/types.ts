// main / preload / renderer で共有する型・定数（node/frida 非依存の純データ）。

export type BuildKey = 'stable' | 'canary' | 'ptb' | 'development'
export const BUILD_ORDER: BuildKey[] = ['stable', 'canary', 'ptb', 'development']
export const BUILD_LABEL: Record<BuildKey, string> = {
  stable: 'Stable',
  canary: 'Canary',
  ptb: 'PTB',
  development: 'Development'
}

export type ConnState = 'disconnected' | 'switching' | 'waiting' | 'connected'

export interface SoundItem {
  id: string
  name: string
  path: string
  fp: string // 内容指紋(mtimeNs_size)。差し替え検出とキャッシュ無効化に使う
  // 音源の出所。今はローカルフォルダのファイルだけ。将来 Discord のサウンドボード音源を
  // 注入するときに 'discord' を足す余地として型だけ先に分けてある(実装はしていない)。
  kind: 'file'
}

export interface AttachResult {
  ok: boolean
  pid: number | null
  label: string
}

// 再生は常に単発・「声に重ねる」(hook.js の mode="add")。replace は自分の声を消してしまい、
// ループは送信ゲートが開きっぱなしになるため、UI からは選べないようにしてある
// (hook.js のプロトコルとしては残っているので、必要になれば injector 側で復帰できる)。
export interface PlayReq {
  srcId: string
  path: string
  fp: string // 内容指紋。プリロード/注入のキャッシュキー(差し替えで旧音を鳴らさない)
  vol: number
}

// preload → engine の再生要求。UI は注入レートを知らないので PlayReq とは分ける。
// engine は srcId / fp / sampleRate でプリロード済み PCM を引く(レートが変わったら別の音源として送り直す)。
export interface InjectPlayReq extends PlayReq {
  sampleRate: number
}

// 永続化する設定(Electron userData/config.json)。getConfig で renderer へ返す。
export interface AppConfig {
  build: BuildKey
  folder: string
  // 送信音量。0..4 で、1.0 = 0dB(従来の 100%)、上限 4.0 = +12dB。
  // +12dB は hook.js の TX_GAIN(0.25 ≒ -12dB)をちょうど打ち消す点で、送信ヘッドルームに
  // よる減衰がゼロになる。ここが上限なので master*TX_GAIN <= 1.0 が保たれ、フルスケール
  // 以内の音源を 1 本だけ 100% 以下で鳴らす限り注入音は歪まない(音源別音量が 100% 超、
  // または同時再生では clamp が効きうる)。
  master: number // 0..4
  sidetoneEnabled: boolean
  sidetoneDevice: string // 出力デバイス deviceId('' = 既定)
  sidetoneVolume: number // 0..1
  // srcId -> 0..1.5。音量調整ダイアログの均一化が全音源ぶんを書き込む。
  sourceVolumes: Record<string, number>
  entrySoundEnabled: boolean // VC 入場時に自動再生する
  entrySoundSrcId: string // 入場音の SoundItem.id('' = 未選択)
  entrySoundVolume: number // 入場音だけの音量 0..1.5(グリッドの sourceVolumes とは独立)
  // 送信ゲートが開いた後、さらに待ってから鳴らす時間。0 でも Connection* 捕捉待ちで
  // 最大 1.5 秒かかるため、これは「その上に足す間」を意味する。
  entryDelayMs: number
  // vc=inactive がこの時間継続して初めて「VC退出」と確定し、次の入場で鳴らす。
  // 短いほど素早いチャンネル移動でも鳴るが、frida 停滞由来の誤検知でも鳴りやすくなる。
  entryLeaveDebounceMs: number
  // 音源の一括均一化で目標にするラウドネス(dBFS)。声とのバランスから推奨する送信音量も
  // この値を基準に計算するため、両者で必ず同じ値を見る。
  normalizeRefDbfs: number
  // 直近の出力レベル計測。null = 未計測。目標プリセットを変えたときに再計測なしで
  // 推奨値を出し直すために保持する。
  calibration: CalibrationRecord | null
}

// hook.js の {ev:"calib"|"calibDone"} のペイロード。すべて線形・フルスケール 1.0。
export interface CalibMeasure {
  tag: string
  frames: number // 実際に測れたフレーム数(経過時間ではない)
  budget: number // フック側のフレーム予算
  total: number // 集計対象サンプル数
  clip: number // 声 + 注入が ±1.0 を超えた(clamp が効いた)サンプル数
  master: number
  txGain: number
  // 声の RMS。hook.js が送るのは絶対ゲート(-50 dBFS)だけを掛けた暫定値で、メーターと
  // 進行表示のためのもの。store.ts が calibDone を受けた時点で vBlocks から
  // shared/loudness.ts の 2 段ゲートを掛けた確定値に差し替える(音源の解析と同じ数え方)。
  vRms: number
  vPeak: number
  vN: number // 声として集計したサンプル数(発話率の分子)
  // 声のフレーム毎の平均二乗。calibDone にだけ載る(途中経過には無い)。
  // これが無い calibDone は暫定値のまま扱う。
  vBlocks?: number[]
  iRms: number // 注入分
  iPeak: number
  iN: number
  vNow: number // 直近フレームの瞬時値(メーター表示用)
  iNow: number
}

// 計測結果の保存形。UI に「いつ・どんな声で測ったか」を出し、再計算にも使う。
// 基準レベルはここに持たない。推奨も「声との差」も常に現在の normalizeRefDbfs から
// 計算するため(基準を変えれば音源の音量も揃え直すので、測定時の基準を残しても
// 参照する側がいない)。
export interface CalibrationRecord {
  at: number // 計測時刻(epoch ms)
  voiceRms: number
  voicePeak: number
  activeRatio: number // 発話フレーム率。低いと信頼できない
  targetDb: number // 声に対して注入音を何 dB にするか
}

export interface SourceStats {
  rms: number // 無音ブロックを除いた RMS(声の計測と同じゲーティング)
  peak: number // 全体の最大振幅。1.0 を超えることがある(mp3 のインターサンプルピーク)
  samples: number
  activeRatio: number // 鳴っている時間の割合。低いほど「間」の多い音源
}

// hook.js / engine から renderer へ流すイベント（ev で分岐）。
export interface EngineEvent {
  ev: string
  [k: string]: unknown
}

// preload が contextBridge で公開する window.api の形（renderer から参照）。
// getConfig の戻り。loadWarning は「この起動で設定を読めなかった理由」で、保存はされない。
// 起動直後に一度だけ画面へ出す(黙って既定値で動くと、ユーザーは設定が消えたことにしか
// 気付けず、しかも最初の保存で元ファイルごと失う)。
export interface LoadedConfig extends AppConfig {
  loadWarning?: string | null
}

export interface Api {
  getConfig: () => Promise<LoadedConfig>
  saveConfig: (partial: Partial<AppConfig>) => Promise<void>
  listBuilds: () => Promise<BuildKey[]>
  attach: (build: BuildKey) => Promise<AttachResult>
  detach: () => Promise<void>
  scanFolder: (folder: string) => Promise<SoundItem[]>
  chooseFolder: () => Promise<string | null>
  getPcm: (path: string) => Promise<ArrayBuffer>
  play: (req: PlayReq) => Promise<string | null>
  stop: (vid: string) => Promise<void>
  stopAll: () => Promise<void>
  setVoiceVolume: (vid: string, vol: number) => Promise<void>
  setMaster: (v: number) => Promise<void>
  // 再生に先立って送信ゲートを開く(入場音の頭欠け防止)。guardMs 以内に再生が
  // 始まらなければ自動で閉じる。
  openGate: (guardMs: number) => Promise<void>
  // 出力レベル計測。frames は hook 側のフレーム予算(100 フレーム ≒ 1 秒)。
  // Node が落ちても計測が残り続けないよう、停止条件はフック側にも持たせてある。
  calibStart: (tag: string, frames: number) => Promise<void>
  calibStop: () => Promise<void>
  // 音源のラウドネス。ffmpeg 変換のキャッシュを使うので初回だけ時間がかかる。
  sourceStats: (path: string) => Promise<SourceStats>
  onEngineEvent: (cb: (p: EngineEvent) => void) => () => void
}
