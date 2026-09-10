import { create } from 'zustand'
import type {
  Api,
  BuildKey,
  CalibMeasure,
  CalibrationRecord,
  ConnState,
  EngineEvent,
  SoundItem
} from '@shared/types'
import { LocalAudio, listOutputDevices } from '@/lib/localAudio'
import { fmtDb, toLinear } from '@/lib/db'
import { validateVoice } from '@/lib/calibration'
import { mockApi } from '@/mockApi'
import { gatedRms } from '@shared/loudness'

// preload が isolated world に置く窓口。Discord の中ではこれが実体で、
// patcher 経由で engine(utilityProcess の子)まで繋がる。
// 素のブラウザ(テストや単体表示)では居ないのでモックへ落ちる。
// undefined を取りうる型のままにしてあるのは、store 側の !api 分岐を消さないため。
export const engineApi: Api | undefined = (globalThis as { api?: Api }).api ?? mockApi
const api = engineApi

// 試聴/サイドトーンのローカル出力(Web Audio)。VC には流れない。
const localAudio = new LocalAudio()
// fp(内容指紋) -> f32 PCM。48k/mono/f32 は 192KB/秒あるので、上限が無いと
// フォルダを切り替えながら鳴らすたびに増え続けて解放されない(fp はファイル由来なので、
// 音源を保存し直すだけでも旧エントリが残ったまま新エントリが積まれる)。
// 挿入順 = 最終使用が古い順(LRU)にして、合計バイト数で頭打ちにする。
const PCM_CACHE_MAX_BYTES = 64 * 1024 * 1024
const pcmCache = new Map<string, ArrayBuffer>()
let pcmCacheBytes = 0
// 取得中の IPC。同じ音源を連打したり、試聴と VC 再生が重なったりすると、await を跨ぐ間に
// 同じキーの取得が何本も走る。まとめないと (1) 同じ PCM を何度も IPC で運ぶ無駄が出るうえ、
// (2) Map は 1 エントリに上書きされるのに合計バイト数だけ呼ばれた回数ぶん加算され、
// 退避で引かれるのは 1 件ぶんだけなので、幻の計上が永久に残る。積もると上限を常時超えた
// 扱いになり、挿入のたびに他が全部退避されてキャッシュが実質無効化する。
const pcmInflight = new Map<string, Promise<ArrayBuffer>>()

// key は内容指紋(fp)。差し替え後は fp が変わり、古い PCM を掴まない。
async function pcmFor(key: string, path: string): Promise<ArrayBuffer | null> {
  if (!api) return null
  const cached = pcmCache.get(key)
  if (cached) {
    pcmCache.delete(key) // 使った順に並べ直す
    pcmCache.set(key, cached)
    return cached
  }
  let job = pcmInflight.get(key)
  if (!job) {
    job = api.getPcm(path)
    pcmInflight.set(key, job)
    // 成否に関わらず必ず外す(失敗を掴んだままだと以後ずっと同じ失敗を返す)。
    void job.catch(() => undefined).finally(() => {
      if (pcmInflight.get(key) === job) pcmInflight.delete(key)
    })
  }
  try {
    const buf = await job
    // 会計は「実際に Map へ入っているもの」とだけ一致させる。
    const prev = pcmCache.get(key)
    if (prev) pcmCacheBytes -= prev.byteLength
    pcmCache.set(key, buf)
    pcmCacheBytes += buf.byteLength
    for (const [k, v] of pcmCache) {
      if (pcmCacheBytes <= PCM_CACHE_MAX_BYTES) break
      if (k === key) continue // 今入れたものは残す(1 件で上限を超える場合)
      pcmCache.delete(k)
      pcmCacheBytes -= v.byteLength
    }
    return buf
  } catch {
    return null
  }
}

// 入場音のように、音源別音量ではない音量で鳴らしたいときの上書き。
export interface PlayOverride {
  vol?: number
}

export interface Voice {
  voiceId: string
  srcId: string
  name: string
  volume: number // 0..1.5
  kind: 'vc' | 'preview'
}

interface Settings {
  master: number // 0..4 (1.0 = 0dB)
  sidetoneEnabled: boolean
  sidetoneDevice: string
  sidetoneVolume: number // 0..1
  entrySoundEnabled: boolean
  entrySoundSrcId: string
  entrySoundVolume: number // 0..1.5
  entryDelayMs: number
  entryLeaveDebounceMs: number
  normalizeRefDbfs: number
  calibration: CalibrationRecord | null
}

// 自分に聞こえる音(試聴・サイドトーン)の gain。相手へ送られる注入音は
// S × vol × master × TX_GAIN なので、モニターにも master を掛けないと、送信音量を動かしても
// (校正で声に合わせても)自分に聞こえる音だけ変わらず、どのつまみが何に効くのか判別できない。
// TX_GAIN(≒-12dB) は掛けない。定数なので声との相対関係は変わらない一方、掛けるとモニターだけが
// 12dB 沈み、上限 100% のモニター音量では取り戻せなくなる。
// 自分の耳と機材を守る最終的な上限。ここは「モニター音量 100% × 音源 150% × 送信音量 +12dB」
// のような端まで振り切った組み合わせでしか届かない位置に置く。実用域(旧 2.0 = 既定のモニター
// 音量 70% なら送信音量 +9dB で頭打ち)に置くと、校正で送信音量を上げた環境では送信音量を
// 動かしても試聴の音量が変わらなくなり、「送信音量が試聴に反映されない」ように見える。
const MONITOR_GAIN_MAX = 4.0
// 上限に当たったことは無言にしない(このリポジトリの規約)。ただしスライダーのドラッグ中は
// 連続で呼ばれるので、同じ通知を出し続けないよう間隔を空ける。
const MONITOR_CLAMP_NOTICE_MS = 10_000
let monitorClampNotifiedAt = 0
function noteMonitorClamp(): void {
  const now = Date.now()
  if (now - monitorClampNotifiedAt < MONITOR_CLAMP_NOTICE_MS) return
  monitorClampNotifiedAt = now
  // set() の更新関数の中から呼ばれることがあるので、状態更新は 1 ティック遅らせる。
  queueMicrotask(() =>
    pushStatus(
      '自分に聞こえる音が安全上限に達しました。ここから送信音量を上げても試聴・モニターの音量は変わりません（相手に届く音量は変わります）'
    )
  )
}

function monitorGain(s: Settings, vol: number): number {
  const raw = s.sidetoneVolume * vol * s.master
  if (!(raw > MONITOR_GAIN_MAX)) return raw > 0 ? raw : 0
  noteMonitorClamp()
  return MONITOR_GAIN_MAX
}

// 出力レベル計測の進行状態。実測値そのもの(CalibMeasure)は last に持つ。
export interface CalibState {
  phase: 'idle' | 'measuring' | 'done' | 'failed'
  frames: number // 実際に測れたフレーム数。経過時間ではないので、マイクが止まれば進まない
  budget: number
  vNow: number // 直近フレームの声のレベル(メーター表示用)
  last: CalibMeasure | null
  message: string // 失敗理由 / 警告
}

const CALIB_IDLE: CalibState = {
  phase: 'idle',
  frames: 0,
  budget: 0,
  vNow: 0,
  last: null,
  message: ''
}

// 送信ゲートの実測状態。相手へ実マイク音声が流れているかを表す唯一の表示用ソース。
//   open    = SetPTTActive(1) が実際に通った(Discord 側のミュート/VAD を無視して送信中)
//   closed  = 通常の VAD 動作
//   unknown = 変更に失敗した / 確認手段を失った(detach)。危険側に倒して扱う
// transmit.ts の FridaGate.open とは別物。あちらは「こちらが要求したフラグ」で、実際に
// Discord へ通ったかは表さない(gateConn 未捕捉なら applyGate は no-op)。名前を分けてあるのは
// 二重管理を混同しないため。
export type MicTransmit = 'closed' | 'open' | 'unknown'

interface State {
  ready: boolean
  attached: boolean
  connection: ConnState
  connectionDetail: string
  micTransmit: MicTransmit
  build: BuildKey
  folder: string
  sounds: SoundItem[]
  search: string
  voices: Voice[]
  sourceVolumes: Record<string, number>
  previewSrc: string | null
  settings: Settings
  devices: { id: string; label: string }[]
  status: string
  // トースト用。status と同じ文言に連番を添えたもの。同じ理由で続けて失敗したときに
  // 「2 回目以降は何も出ない」を防ぐ(値が変わらないと effect が動かないため)。
  notice: { msg: string; seq: number }
  calib: CalibState
  // 音量調整ダイアログの開閉。TopBar と右レールの両方に導線があるため、
  // どちらから開いても同じ実体になるよう状態はここに置く。
  levelOpen: boolean
  // lifecycle
  init: () => Promise<void>
  connect: (build: BuildKey) => Promise<void>
  reload: () => Promise<void>
  chooseFolder: () => Promise<void>
  // controls
  setBuild: (b: BuildKey) => void
  setSearch: (s: string) => void
  // Live 版は音へ即反映するだけで保存しない。スライダーのドラッグ中(onValueChange)に使い、
  // 保存は指を離したとき(onValueCommit)に無印の方を呼ぶ。
  setMaster: (v: number) => void
  setMasterLive: (v: number) => void
  patchSettings: (p: Partial<Settings>) => void
  setSourceVolume: (srcId: string, v: number) => void
  setSourceVolumeLive: (srcId: string, v: number) => void
  volFor: (srcId: string) => number
  // その音源の音量が「揃えてある」か(sourceVolumes にキーがあるか)。校正後に追加/リネームした
  // 音源だけが未調整のまま残り、相手には基準とのズレぶん大きく(小さく)届くため、
  // 画面側でそれと分かるようにするための判定。値そのものは勝手に書き換えない。
  isVolumeAdjusted: (srcId: string) => boolean
  play: (srcId: string, override?: PlayOverride) => Promise<void>
  stopVoice: (voiceId: string) => void
  setVoiceVolume: (voiceId: string, v: number) => void
  stopAll: () => void
  togglePreview: (srcId: string, volOverride?: number) => void
  stopPreview: () => void
  testEntrySound: () => void
  setStatus: (msg: string) => void
  // calibration
  setLevelOpen: (v: boolean) => void
  startVoiceCalib: (seconds: number) => void
  cancelCalib: () => void
  // targetDb を渡すと通知を「声との差」で語る(内部量の送信ゲインを見せない)。
  applyMasterDb: (db: number, targetDb?: number) => void
  saveCalibration: (rec: CalibrationRecord) => void
}

const MOCK_SOUNDS: SoundItem[] = [
  'ドラムロール',
  '拍手',
  'ファンファーレ',
  'boing',
  'レーザー',
  'コイン',
  'ぱふぱふ',
  'ため息',
  'ブザー',
  'キラーン',
  'ドンッ',
  'わーい'
].map((n) => ({ id: n, name: `${n}.wav`, path: `C:/sounds/${n}.wav`, fp: '0' }))

// 規約: ユーザーの操作を受けて処理を中断する早期 return は、理由が画面から自明でない限り
// 必ず set({ status: ... }) で理由を出す。無言 return は「押したのに何も起きない」という、
// 最も原因を追いにくい形の不具合になる。
// ただし内部の整合性ガード(connectSeq のような世代トークン、二重 init の抑止)は対象外。
// ユーザーの操作に対応しておらず、出すと無意味な通知が増えるだけ。
let seq = 1
let initStarted = false // React StrictMode の二重 init(→二重 attach)を防ぐ
let connectSeq = 0 // 連続ビルド切替で古い attach 結果が後勝ちするのを防ぐ世代トークン
// 「音量を揃えていない音源」を鳴らしたことを知らせた srcId。校正済みの環境では送信音量が
// 「全音源が normalizeRefDbfs に揃っている」前提で決まるため(calibration.ts)、校正後に
// 追加/リネームした音源だけが素の録音レベルのまま相手へ届く。音量を勝手に書き換えると
// 「触っていないのに音が変わった」になるので、最初に鳴らしたときだけ理由を知らせる。
const unadjustedNotified = new Set<string>()

// ---- VC 入場音 ----
// hook.js の vc イベントは Krisp フレームのハートビート由来で、「VC 入場」ではなく
// 「マイク処理が回り始めたこと」しか表さない。チャンネル移動・瞬断復帰に加え、frida VM の
// 停滞でも一過性の false→true が立つ(transmit.ts の vcRevertDelayMs と同じ問題)。
// そこで「安定した退出(entryLeaveDebounceMs 継続)を観測してから武装する」ことで誤発火を抑え、
// 初期値 false によりアプリ起動時に既に VC に居るケースでも鳴らさない。
const ENTRY_GATE_WAIT_MS = 1500 // ゲートが実際に開くのを待つ上限
// 先行オープンしたゲートを強制的に閉じるまでの猶予。待ち時間より長くしないと、待ち切って
// play する直前にガードが発火してしまう。長すぎると再生されないまま生マイクが流れるので、
// 待ち時間 + play の往復に足りる程度に留める(閉じても play 開始で開き直る)。
const ENTRY_GATE_GUARD_MS = 3000
const ENTRY_COOLDOWN_MS = 5000 // 発火後の再発火抑止(入場音自体が hb を停滞させる自己励振の保険)
let entryArmed = false
let entryLeaveTimer: ReturnType<typeof setTimeout> | null = null
let entryCooldownUntil = 0
let entryFiring = false
let gateOpenWaiters: (() => void)[] = []
// 直近に観測した Connection*。hook.js は GetStats で捕捉したポインタが**変わったときだけ**
// gateInfo を送るので、これが変われば「本当に VC を張り直した」ことになる。
// 入場音の発火はこれを条件にする。ハートビート(vc イベント)だけを根拠にすると、
// 自分をミュートして 2.5 秒以上おいてから解除しただけで「入場した」と誤認し、
// 効果音が相手へ流れてしまう(ミュートでは Connection* は変わらない)。
let lastGateConn: string | null = null

function resetEntryState(): void {
  if (entryLeaveTimer) {
    clearTimeout(entryLeaveTimer)
    entryLeaveTimer = null
  }
  entryArmed = false
  entryFiring = false
  gateOpenWaiters = []
  lastGateConn = null
}

// ---- 出力レベル計測 ----
// hook 側にもフレーム予算があるので、Node/renderer が落ちても計測は自動終了する。
// こちらのタイマーは「フレームが届かなくなった」= マイク処理が回っていない場合の検出用。
// hook のフレーム予算はフレームが来ないと減らないので、そちら側は止まらない。
const CALIB_SILENT_MS = 1500
let calibSilentTimer: ReturnType<typeof setTimeout> | null = null

function clearCalibTimer(): void {
  if (calibSilentTimer) {
    clearTimeout(calibSilentTimer)
    calibSilentTimer = null
  }
}

// 「フレームが途絶えた」の監視を張り直す。開始時だけでなく途中経過を受けるたびに掛け直す
// のは、測定の途中でマイクがミュートされた/frida VM が止まった場合に、hook のフレーム予算は
// フレームが来ないと減らないため、こちらが張り直さないと「測定中」から永久に戻らないため。
function armCalibTimer(): void {
  clearCalibTimer()
  calibSilentTimer = setTimeout(() => {
    calibSilentTimer = null
    if (useStore.getState().calib.phase !== 'measuring') return
    void api?.calibStop()
    useStore.setState((s) => ({
      calib: {
        ...s.calib,
        phase: 'failed',
        message: 'マイクの音声が処理されていません。ミュートを解除してください'
      }
    }))
    // calib.message はダイアログ内にしか出ないので、閉じていても気付けるよう通知も出す。
    pushStatus('声の測定を中断しました: マイクの音声が処理されていません')
  }, CALIB_SILENT_MS)
}

// 声の測定値を確定させる。hook.js が送ってくる vRms は絶対ゲートだけの暫定値なので、
// フレーム毎の平均二乗(vBlocks)から音源解析と同じ 2 段ゲートを掛け直す。
// これをしないと、定常的な「あー」と減衰テールの長い効果音が違う数え方で測られ、
// 「声に合わせたのに効果音だけ相手に大きく届く」が残る。
function finalizeMeasure(m: CalibMeasure): CalibMeasure {
  if (!Array.isArray(m.vBlocks) || m.vBlocks.length === 0) return m
  const g = gatedRms(m.vBlocks)
  // 全ブロックが無音だったときは暫定値(こちらも 0)のままにして、判定は validateVoice に委ねる。
  if (g.gatedBlocks === 0) return m
  return { ...m, vRms: g.rms }
}

// hook.js / frida から来る英語のメッセージを、ユーザーが読める日本語へ写像する。
// ここを通さないと「discord_krisp.node not loaded」のような文字列がそのままトーストに出る。
// とくに Krisp/ゲートの export 未検出は「Discord の更新で動かなくなった」という最も
// 起きやすい致命的状態の通知なので、英語のままだと実質「無告知」になる。
export function humanizeEngineMessage(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('krisp') && (m.includes('not loaded') || m.includes('not found'))) {
    return 'Discord の音声モジュールに対応できませんでした。Discord の更新で内部構造が変わった可能性があります。別のビルド(Stable / Canary)を試すか、VoiceCord の更新をご確認ください'
  }
  if (m.includes('getstats') || m.includes('setpttactive') || m.includes('discord_voice.node')) {
    return '送信の自動 ON/OFF に対応できませんでした。音が鳴っても相手に届かないことがあります。別のビルドを試すか、Discord のプッシュトゥトークを押しながらお試しください'
  }
  return raw
}

// 再生が拒否された理由(hook.js が返す英語のコード)を日本語にする。
function humanizeRejectReason(reason: string): string {
  if (reason.includes('voice limit')) {
    return '同時に鳴らせるのは 8 音までです。再生中のサウンドを止めてからお試しください'
  }
  if (reason.startsWith('no source')) {
    return '音源データを読み込めませんでした。サウンド一覧を再読込してからお試しください'
  }
  return `再生できませんでした（${reason}）`
}

// hook.js の {ev:'gate', open:true}(SetPTTActive が実際に通ったときだけ出る)を待つ。
// gateInfo は Connection* が「変化した」ときにしか出ないため待ち受けには使えない。
function waitGateOpen(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    gateOpenWaiters.push(finish)
  })
}

// status を含む更新は必ず notice も進める。トーストは notice(連番付き)を見るので、
// 同じ文言が連続しても毎回表示される。set をラップしてあるので、通知を出す側は
// これまでどおり set({ status: ... }) と書けばよい(書き忘れで黙る経路を作らない)。
let noticeSeq = 0
function withNotice(patch: Partial<State>): Partial<State> {
  if (!('status' in patch)) return patch
  return { ...patch, notice: { msg: patch.status ?? '', seq: ++noticeSeq } }
}
// store の外(タイマーなど)から通知するとき用。ラップした set を通れないため個別に用意する。
function pushStatus(msg: string): void {
  useStore.setState(withNotice({ status: msg }))
}

export const useStore = create<State>((rawSet, get) => {
  const set = (partial: Partial<State> | ((s: State) => Partial<State>)): void => {
    if (typeof partial === 'function') rawSet((s) => withNotice(partial(s)))
    else rawSet(withNotice(partial))
  }
  return {
  ready: false,
  // モック(素のブラウザで描画確認する場合)は接続済みとして扱う。connection だけ
  // 'connected' にして attached を false のままにすると、接続前提の UI が
  // 「VC通話中なのに未接続」という実機では起きない状態で描画されてしまう。
  attached: !api,
  connection: api ? 'disconnected' : 'connected',
  connectionDetail: api ? '' : 'モック（frida 未接続）',
  micTransmit: 'closed',
  build: 'canary',
  folder: '',
  sounds: api ? [] : MOCK_SOUNDS,
  search: '',
  voices: api
    ? []
    : ([{ voiceId: 'v0', srcId: '拍手', name: '拍手', volume: 0.4, kind: 'vc' }] as Voice[]),
  sourceVolumes: (api ? {} : { 拍手: 0.4 }) as Record<string, number>,
  previewSrc: null,
  settings: {
    master: 0.8,
    sidetoneEnabled: false,
    sidetoneDevice: '',
    sidetoneVolume: 0.7,
    entrySoundEnabled: false,
    entrySoundSrcId: '',
    entrySoundVolume: 1.0,
    entryDelayMs: 0,
    entryLeaveDebounceMs: 2500,
    normalizeRefDbfs: -14,
    calibration: null
  },
  devices: [],
  status: '',
  notice: { msg: '', seq: 0 },
  calib: CALIB_IDLE,
  levelOpen: false,

  init: async () => {
    if (initStarted) return
    initStarted = true
    if (!api) {
      set({ ready: true })
      return
    }
    // VC 入場音の発火。ゲートを先に開いてから鳴らす(VC 入場直後は Connection* 未捕捉で
    // ゲートが噛まず、同時に鳴らすと音の頭が送信されないため)。
    const fireEntrySound = async (): Promise<void> => {
      if (!api) return
      const st = get()
      if (!st.settings.entrySoundEnabled) return
      const srcId = st.settings.entrySoundSrcId
      if (!srcId) return
      if (entryFiring) return
      if (Date.now() < entryCooldownUntil) {
        // 無言で捨てると「退出とみなす時間を短くしたのに鳴らない」の原因が分からない。
        // この抑止は設定に出していない固定値なので、なおさら理由が要る。
        set({
          status: `入場サウンドは前回の再生から ${Math.round(ENTRY_COOLDOWN_MS / 1000)} 秒は鳴らしません`
        })
        return
      }
      const snd = st.sounds.find((s) => s.id === srcId)
      if (!snd) {
        set({ status: `入場サウンドが見つかりません: ${srcId}` })
        return
      }
      entryFiring = true
      entryCooldownUntil = Date.now() + ENTRY_COOLDOWN_MS
      try {
        // ゲートを開く前に PCM 変換を済ませる。初回は ffmpeg が走って数秒かかることがあり、
        // 先に開いてしまうとその間ずっと生マイクが送信されてしまう。
        await pcmFor(snd.fp, snd.path)
        if (get().connection !== 'connected') return // 変換中に VC を抜けたら開かない
        // 設定は await を跨ぐたびに取り直す(待っている間にユーザーが変更しうるため、
        // 関数先頭のスナップショットを使うと古い値で鳴らしてしまう)。
        // 追加ディレイの間もゲートは開けたままにするので、その分ガードを延ばす。
        const delay = get().settings.entryDelayMs
        await api.openGate(ENTRY_GATE_GUARD_MS + delay)
        await waitGateOpen(ENTRY_GATE_WAIT_MS)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        // 待っている間に VC を抜けた場合は鳴らさない(play 側でも弾かれるが状態を汚さない)
        if (get().connection !== 'connected') return
        const cfg = get().settings
        // 送信自体は行う。無言で何も起きないと設定ミスに気付けないので通知だけ出す。
        if (cfg.entrySoundVolume === 0) {
          set({ status: '入場音の音量が 0% です。音が出ていないかもしれません' })
        }
        // 音量だけは入場音専用の値を使う(音源別音量とは独立)。
        await get().play(srcId, { vol: cfg.entrySoundVolume })
      } catch (e) {
        set({ status: '入場サウンド失敗: ' + String(e) })
      } finally {
        entryFiring = false
      }
    }

    api.onEngineEvent((p: EngineEvent) => {
      switch (p.ev) {
        case 'vc': {
          const active = !!(p as { active?: boolean }).active
          // VC 退出時、hook.js は gateConn を捨てるだけで gateApplied は据え置くため
          // 'gate' が飛ばない。ここで落とさないと「開」のまま凍結し、VC にいないのに
          // 送信中と表示し続ける。通話していない間は何も送信されないので閉で正しい。
          // 再入場時に gateForced が残っていれば、新しい Connection* の捕捉で
          // gateApplied が false に戻ってから applyGate(true) が走るので 'gate' が飛ぶ。
          set((s) => ({
            connection: active ? 'connected' : s.attached ? 'waiting' : 'disconnected',
            micTransmit: active ? s.micTransmit : 'closed'
          }))
          // VC を抜けると Krisp の onLeave が止まり、1フレームも測れなくなる。
          if (!active && get().calib.phase === 'measuring') {
            clearCalibTimer()
            void api?.calibStop()
            set((s) => ({
              calib: { ...s.calib, phase: 'failed', message: 'VC から切断されたため中断しました' }
            }))
          }
          if (active) {
            if (entryLeaveTimer) {
              clearTimeout(entryLeaveTimer)
              entryLeaveTimer = null
            }
            // ここでは発火しない。vc=true は「マイク処理が回り始めた」だけで、
            // ミュート解除でも立つ。実際の発火は gateInfo(Connection* の張り替え)側で行う。
          } else if (!entryLeaveTimer) {
            // 一過性の vc=false では武装しない。継続して初めて「退出した」と確定する。
            entryLeaveTimer = setTimeout(() => {
              entryLeaveTimer = null
              entryArmed = true
            }, get().settings.entryLeaveDebounceMs)
          }
          break
        }
        case 'gate': {
          // gateApplied が実際に変化したときだけ来る = 送信状態の唯一の確定信号。
          const open = !!(p as { open?: boolean }).open
          set({ micTransmit: open ? 'open' : 'closed' })
          // 送信ゲートが実際に開いた。入場音の待ち受けを解除する。
          if (open) {
            const waiters = gateOpenWaiters
            gateOpenWaiters = []
            for (const w of waiters) w()
          }
          break
        }
        case 'gateInfo': {
          // Connection* を(再)捕捉した直後。hook.js はこの送信の直後に必ず
          // applyGate(true)(gateForced 中) か applyGate(false)(無条件クローズ) を呼ぶので、
          // この時点の確定状態は「閉」。開くケースは直後の 'gate' が上書きする。
          // ここを拾わないと、'unknown' に落ちた後の復帰で 'gate' が飛ばず
          // (gateApplied は既に false のため)、警告が永久に消えなくなる。
          set({ micTransmit: 'closed' })
          // Connection* が別物になった = 本当に VC を張り直した。入場音はここでだけ鳴らす。
          // hook.js はポインタが変化したときにしか gateInfo を送らないので、ミュートの
          // 解除では届かず、誤発火しない。
          const conn = (p as { conn?: string }).conn ?? null
          if (conn && conn !== lastGateConn) {
            lastGateConn = conn
            if (entryArmed) {
              entryArmed = false
              void fireEntrySound()
            }
          }
          break
        }
        case 'voiceEnded': {
          const vid = (p as { voiceId?: string }).voiceId
          if (vid) localAudio.stop(vid) // サイドトーンも停止
          set((s) => ({ voices: s.voices.filter((v) => v.voiceId !== vid) }))
          break
        }
        case 'playRejected': {
          const vid = (p as { voiceId?: string }).voiceId
          const reason = (p as { reason?: string }).reason ?? ''
          if (vid) localAudio.stop(vid) // 遅延サイドトーンが単独で鳴るのを止める
          set((s) => ({
            voices: s.voices.filter((v) => v.voiceId !== vid),
            status: humanizeRejectReason(reason)
          }))
          break
        }
        case 'calib': {
          const m = p as unknown as CalibMeasure
          // 届いたので生存を確認できた。次のフレームが来ないケースに備えて張り直す。
          if (get().calib.phase === 'measuring') armCalibTimer()
          set((s) => ({
            calib: { ...s.calib, frames: m.frames, budget: m.budget, vNow: m.vNow, last: m }
          }))
          break
        }
        case 'calibDone': {
          const m = finalizeMeasure(p as unknown as CalibMeasure)
          clearCalibTimer()
          set((s) => {
            // 中断済み(VC 切断など)なら結果で上書きしない。
            if (s.calib.phase !== 'measuring') return { calib: { ...s.calib, last: m } }
            const v = validateVoice(m)
            return {
              calib: {
                ...s.calib,
                frames: m.frames,
                budget: m.budget,
                vNow: 0,
                last: m,
                phase: v.ok ? 'done' : 'failed',
                message: v.reason ?? v.warn ?? ''
              }
            }
          })
          break
        }
        case 'detached': {
          // Discord 終了 / プロセス消滅 / frida 切断。接続状態を落とし、残った行を掃除。
          localAudio.stopAll()
          resetEntryState()
          clearCalibTimer()
          set((s) => ({
            attached: false,
            connection: 'disconnected',
            connectionDetail: 'Discord との接続が切れました',
            // 開いていたなら「不明」へ格上げする。frida セッションが死んだ後は
            // SetPTTActive を撃つ手段が無く、Discord 側に常時送信フラグが残っている
            // 可能性がある(engine 側の gateClose は script=null で no-op になる)。
            // 閉じていたことが分かっているならそのまま閉。
            micTransmit: s.micTransmit === 'open' ? 'unknown' : s.micTransmit,
            voices: [],
            previewSrc: null,
            calib:
              s.calib.phase === 'measuring'
                ? { ...s.calib, phase: 'failed', message: 'Discord との接続が切れたため中断しました' }
                : s.calib
          }))
          break
        }
        case 'gateUnsafe': {
          // SetPTTActive が例外を投げた = 開閉のどちらに失敗したか分からない。
          // 危険側に倒して「不明」にする(閉じたことにしない)。
          const msg = (p as { msg?: string }).msg
          set({
            micTransmit: 'unknown',
            ...(msg ? { status: humanizeEngineMessage(String(msg)) } : {})
          })
          break
        }
        case 'status':
        case 'error': {
          const msg = (p as { msg?: string }).msg
          if (msg) set({ status: humanizeEngineMessage(String(msg)) })
          break
        }
        default:
          break
      }
    })
    try {
      const cfg = await api.getConfig()
      set({
        folder: cfg.folder,
        build: cfg.build,
        sourceVolumes: cfg.sourceVolumes ?? {},
        settings: {
          master: cfg.master,
          sidetoneEnabled: cfg.sidetoneEnabled,
          sidetoneDevice: cfg.sidetoneDevice,
          sidetoneVolume: cfg.sidetoneVolume,
          entrySoundEnabled: cfg.entrySoundEnabled,
          entrySoundSrcId: cfg.entrySoundSrcId,
          entrySoundVolume: cfg.entrySoundVolume,
          entryDelayMs: cfg.entryDelayMs,
          entryLeaveDebounceMs: cfg.entryLeaveDebounceMs,
          normalizeRefDbfs: cfg.normalizeRefDbfs,
          calibration: cfg.calibration
        }
      })
      // 設定を読めなかった起動では、その理由を最初に出す。既定値で静かに動き出すと
      // 「校正も音量も消えた」ことにしか気付けない。
      if (cfg.loadWarning) set({ status: cfg.loadWarning })
      const sounds = await api.scanFolder(cfg.folder)
      set({ sounds })
      // 出力デバイス列挙 + サイドトーン/試聴の出力先を設定
      const devices = await listOutputDevices()
      set({ devices })
      void localAudio.setDevice(cfg.sidetoneDevice).catch((e) => set({ status: String(e) }))
      await get().connect(cfg.build)
    } catch (e) {
      set({ status: '初期化エラー: ' + String(e) })
    }
    set({ ready: true })
  },

  connect: async (build) => {
    if (!api) return
    const seq = ++connectSeq
    // 切替開始で古い再生行/試聴/サイドトーンを掃除(旧セッションの幽霊行を残さない)。
    localAudio.stopAll()
    resetEntryState() // 旧セッションの武装状態を持ち越さない
    // ここで落とすのは「旧セッションについて知っていたこと」すべて。新しい状態を足すときは
    // ここに入れ忘れないこと(detail を残すと切替中に前のビルドの PID が出たままになり、
    // micTransmit を残すと繋がっていないのに「マイク送信中」が出たままになる)。
    //
    // micTransmit を closed ではなく unknown にするのは、切替の内部 detach では
    // injector の session ガードにより {ev:'detached'} が飛ばず、hook からの gate 応答も
    // 届かないまま旧セッションが捨てられるため。実際に閉じられたかを確認する手段が無い。
    // 新しいセッションで Connection* を捕捉すれば gateInfo が来て closed に戻る。
    set((s) => ({
      connection: 'switching',
      build,
      attached: false,
      connectionDetail: '',
      micTransmit: s.micTransmit === 'open' ? 'unknown' : s.micTransmit,
      voices: [],
      previewSrc: null
    }))
    try {
      const r = await api.attach(build)
      if (seq !== connectSeq) return // より新しい切替に追い越された
      if (r.ok) {
        // VC 在席は hook.js の 'vc' で確定する。それまで待機中。
        set({ attached: true, connection: 'waiting', connectionDetail: `${r.label}  PID ${r.pid}` })
        await api.setMaster(get().settings.master)
      } else {
        set({
          attached: false,
          connection: 'disconnected',
          connectionDetail: `${r.label} 見つからず`
        })
      }
    } catch (e) {
      if (seq !== connectSeq) return
      set({ attached: false, connection: 'disconnected', status: 'アタッチ失敗: ' + String(e) })
    }
  },

  reload: async () => {
    if (!api) return
    const folder = get().folder
    if (!folder) return
    const sounds = await api.scanFolder(folder)
    set({ sounds })
  },

  chooseFolder: async () => {
    if (!api) return
    const folder = await api.chooseFolder()
    if (!folder) return
    set({ folder })
    void api.saveConfig({ folder })
    const sounds = await api.scanFolder(folder)
    set({ sounds })
  },

  setBuild: (b) => {
    if (b === get().build) return
    void api?.saveConfig({ build: b })
    void get().connect(b)
  },
  setSearch: (s) => set({ search: s }),
  // Live は「音に即反映するが保存しない」。スライダーのドラッグ中に呼ばれる。
  // Radix Slider の onValueChange は pointermove ごとに発火するので、ここで保存すると
  // 1 回のドラッグで config.json への同期書き込みが数十回走る。
  setMasterLive: (v) => {
    set((st) => ({ settings: { ...st.settings, master: v } }))
    void api?.setMaster(v)
    // モニターの gain は再生開始時に焼き込まれるので、鳴っている音にも掛け直す
    // (これが無いと送信音量を動かしても、鳴らし直すまで自分に聞こえる音が変わらない)。
    const st = get()
    for (const vc of st.voices) localAudio.setVolume(vc.voiceId, monitorGain(st.settings, vc.volume))
  },
  setMaster: (v) => {
    get().setMasterLive(v)
    void api?.saveConfig({ master: v })
  },
  patchSettings: (p) => {
    set((st) => ({ settings: { ...st.settings, ...p } }))
    void api?.saveConfig(p)
    if (p.sidetoneDevice !== undefined) {
      void localAudio.setDevice(p.sidetoneDevice).catch((e) => set({ status: String(e) }))
    }
    // モニター音量は再生開始時に gain へ焼き込まれるため、変更したら鳴っているモニター音の
    // gain も計算し直す(これが無いとバーが効かない)。
    if (p.sidetoneVolume !== undefined) {
      // 試聴も「自分に聞こえる音」なので同じ規則に従わせる(kind を問わず掛け直す)。
      const st = get()
      for (const vc of st.voices) localAudio.setVolume(vc.voiceId, monitorGain(st.settings, vc.volume))
    }
    // サイドトーンを OFF にしたら、鳴っているモニター音を止める(試聴は残す)
    if (p.sidetoneEnabled === false) {
      for (const vc of get().voices) if (vc.kind === 'vc') localAudio.stop(vc.voiceId)
    }
  },
  setSourceVolume: (srcId, v) => {
    get().setSourceVolumeLive(srcId, v)
    void api?.saveConfig({ sourceVolumes: get().sourceVolumes })
  },
  setSourceVolumeLive: (srcId, v) =>
    set((st) => {
      const sourceVolumes = { ...st.sourceVolumes, [srcId]: v }
      if (st.previewSrc !== srcId) return { sourceVolumes }
      // 試聴中なら鳴っている音量を即反映。あわせて試聴行の volume も更新する
      // (これが無いとライブキューのスライダーがつまみを離した瞬間に元の値へ戻り、
      //  実ゲインだけ変わって「動かないスライダー」に見える)。
      localAudio.setVolume('preview', monitorGain(st.settings, v))
      return {
        sourceVolumes,
        voices: st.voices.map((x) => (x.kind === 'preview' ? { ...x, volume: v } : x))
      }
    }),
  // 音源別音量。未測定の音源(音量調整を開く前に追加されたファイル等)は等倍で鳴らす。
  volFor: (srcId) => get().sourceVolumes[srcId] ?? 1.0,
  isVolumeAdjusted: (srcId) => get().sourceVolumes[srcId] !== undefined,

  play: async (srcId, override) => {
    const st0 = get()
    const snd = st0.sounds.find((s) => s.id === srcId)
    if (!snd) {
      set({ status: `サウンドが見つかりません: ${srcId}。一覧を再読込してください` })
      return
    }
    const vol = override?.vol ?? st0.volFor(srcId)
    if (!api) {
      const voiceId = `v${seq++}`
      set({ voices: [...st0.voices, { voiceId, srcId, name: snd.id, volume: vol, kind: 'vc' }] })
      return
    }
    // VC 通話中(connected)でなければ再生しない。attach 済みでも待機中(waiting)は
    // 送信ゲートが噛まず音が届かないため、行だけが積まれるのを防ぐ。
    if (st0.connection !== 'connected') {
      set({ status: 'VC に接続してから再生してください' })
      return
    }
    // 校正済みなのに音量が未調整の音源は、この音だけ基準とのズレぶん大きく(小さく)相手へ
    // 届く。画面の音量バーは 100% を指すだけでそれと分からないので、最初の 1 回だけ知らせる。
    // 入場音のように専用音量で鳴らす場合は音源別音量を使っていないので対象外。
    if (
      override?.vol === undefined &&
      st0.settings.calibration &&
      !st0.isVolumeAdjusted(srcId) &&
      !unadjustedNotified.has(srcId)
    ) {
      unadjustedNotified.add(srcId)
      set({
        status: `${snd.id} はまだ音量を揃えていません。音量調整の「音源の音量を揃える」を実行するまで、この音だけ相手への大きさがずれます`
      })
    }
    try {
      const vid = await api.play({ srcId, path: snd.path, fp: snd.fp, vol })
      if (!vid) {
        // engine 側は attach していないと null を返す(engine/index.ts の play)。
        // 上の connection チェックは呼び出し時点のスナップショットなので、await の間に
        // 切れているとここへ来る。main も renderer も黙ると完全な無反応になる。
        set({ status: 'Discord との接続が切れたため再生できませんでした' })
        return
      }
      // await 中に切替/detach された場合は取り消す(古いスナップショットで行を作らない)。
      if (!get().attached) {
        void api.stop(vid)
        return
      }
      set((s) => ({
        voices: [...s.voices, { voiceId: vid, srcId, name: snd.id, volume: vol, kind: 'vc' }]
      }))
      // サイドトーン: 同じ音を自分の出力でも鳴らす(モニター音量×サウンド別音量)。
      // 設定は await を跨いだ後の値を見る(関数先頭のスナップショットだと、待っている間に
      // OFF にされたのにモニターだけ鳴り出す)。
      if (get().settings.sidetoneEnabled) {
        const pcm = await pcmFor(snd.fp, snd.path)
        // PCM 取得の遅延中に停止/拒否(voiceEnded/playRejected)されていたら鳴らさない。
        if (pcm && get().voices.some((v) => v.voiceId === vid)) {
          void localAudio.play(vid, snd.fp, pcm, monitorGain(get().settings, vol), false)
        }
      }
    } catch (e) {
      set({ status: '再生失敗: ' + String(e) })
    }
  },

  stopVoice: (voiceId) => {
    void api?.stop(voiceId)
    localAudio.stop(voiceId)
    set((st) => ({ voices: st.voices.filter((v) => v.voiceId !== voiceId) }))
  },
  setVoiceVolume: (voiceId, v) => {
    void api?.setVoiceVolume(voiceId, v)
    // サイドトーンにも反映
    localAudio.setVolume(voiceId, monitorGain(get().settings, v))
    set((st) => ({
      voices: st.voices.map((x) => (x.voiceId === voiceId ? { ...x, volume: v } : x))
    }))
  },
  stopAll: () => {
    void api?.stopAll()
    localAudio.stopAll()
    set({ voices: [], previewSrc: null })
  },

  // 試聴: VC へ送らず自分の出力だけで単発再生(Web Audio)。150% も反映(GainNode で増幅)。
  // gain は monitorGain()。試聴もサイドトーンも「自分に聞こえる音」なので、片方だけ
  // モニター音量や送信音量を無視すると同じ音が試聴と再生で音量が違って聞こえ、
  // ユーザーは機器の不調を疑うことになる。
  togglePreview: (srcId, volOverride) => {
    const st = get()
    if (st.previewSrc === srcId) {
      get().stopPreview()
      return
    }
    const snd = st.sounds.find((s) => s.id === srcId)
    if (!snd) {
      set({ status: `サウンドが見つかりません: ${srcId}。一覧を再読込してください` })
      return
    }
    localAudio.stop('preview') // 直前の試聴を止めてから切替
    const vol = volOverride ?? st.volFor(srcId)
    // モニター音量が 0 だと試聴も無音になる(自分に聞こえる音は全てこれに従うため)。
    // 「押しても何も鳴らない」で終わらせず、理由を出す。
    if (st.settings.sidetoneVolume <= 0) {
      set({ status: 'モニター音量が 0% です。設定 > モニター で上げてください' })
    } else if (st.settings.master <= 0) {
      // 送信音量もモニターに掛かるようになったので、こちらが 0 でも試聴は無音になる。
      set({ status: '送信音量が -∞ dB です。上部バーの音量を上げてください' })
    }
    set({
      previewSrc: srcId,
      voices: [
        ...st.voices.filter((v) => v.kind !== 'preview'),
        { voiceId: 'preview', srcId, name: snd.id, volume: vol, kind: 'preview' }
      ]
    })
    if (!api) return // モックでは行表示のみ
    void (async () => {
      const pcm = await pcmFor(snd.fp, snd.path)
      if (!pcm) return
      if (get().previewSrc !== srcId) return // 待機中に停止/切替された
      await localAudio.play('preview', snd.fp, pcm, monitorGain(get().settings, vol), false, () => {
        // 自然終了 → 試聴行を撤去
        const s = get()
        if (s.previewSrc === srcId) {
          set({ previewSrc: null, voices: s.voices.filter((v) => v.kind !== 'preview') })
        }
      })
    })()
  },

  // 試聴を止める(鳴っていなければ何もしない)。画面を閉じるときの後始末にも使う。
  stopPreview: () => {
    const st = get()
    if (!st.previewSrc) return
    localAudio.stop('preview')
    set({ previewSrc: null, voices: st.voices.filter((v) => v.kind !== 'preview') })
  },

  // 入場音のテスト再生。VC へは送らず自分の端末だけで鳴らす(既存の試聴経路)。
  // 送信音量までは掛かるが、送信 headroom(TX_GAIN)は掛からないので絶対音量は一致しない。
  // 一致するのは音源どうし・設定変更前後の相対関係まで。
  testEntrySound: () => {
    const st = get()
    const srcId = st.settings.entrySoundSrcId
    if (!srcId) {
      set({ status: '入場サウンドが選択されていません' })
      return
    }
    if (!st.sounds.some((s) => s.id === srcId)) {
      set({ status: `入場サウンドが見つかりません: ${srcId}` })
      return
    }
    get().togglePreview(srcId, st.settings.entrySoundVolume)
  },

  setStatus: (msg) => set({ status: msg }),

  setLevelOpen: (v) => {
    // 閉じたら計測を止める。画面外で走り続けるとホットパスに負荷が残る。
    if (!v && get().calib.phase === 'measuring') get().cancelCalib()
    set({ levelOpen: v })
  },

  // 声のレベル計測を開始する。VC へは何も送らない(送信ゲートにも触らない)。
  // Krisp の onLeave は VC 通話中しか回らないので、通話中でなければ 1 フレームも測れない。
  startVoiceCalib: (seconds) => {
    const st = get()
    if (!api) return
    if (!st.attached) {
      set({ calib: { ...CALIB_IDLE, phase: 'failed', message: 'Discord に接続してください' } })
      return
    }
    if (st.connection !== 'connected') {
      set({
        calib: {
          ...CALIB_IDLE,
          phase: 'failed',
          message: 'VC に参加してください（通話中でないとマイク処理が回らず測定できません）'
        }
      })
      return
    }
    // 48kHz / 480 サンプルなので 100 フレーム ≒ 1 秒。
    const frames = Math.max(100, Math.round(seconds * 100))
    set({ calib: { ...CALIB_IDLE, phase: 'measuring', budget: frames } })
    void api.calibStart('voice', frames)
    // フレームが届かない = マイクがミュート、または Krisp が回っていない。
    armCalibTimer()
  },

  cancelCalib: () => {
    clearCalibTimer()
    if (get().calib.phase === 'measuring') void api?.calibStop()
    set({ calib: CALIB_IDLE })
  },

  // 送信音量へ適用する。上部フェーダーの値は変わるが、ダイアログを見ている間は
  // 目に入らないので、適用したことを通知する(押したのに何も起きないように見えるため)。
  //
  // 通知は targetDb(声との差)で語る。生の送信ゲイン(db)は UI のどこにも出ていない内部量で、
  // それをトーストに出すと「トースト +12.0 dB / フェーダー +4.6 dB」のように
  // 1 操作に対して別々の数字が並んでしまう。
  applyMasterDb: (db, targetDb) => {
    get().setMaster(toLinear(db))
    const msg =
      targetDb === undefined
        ? `送信音量を ${fmtDb(db)} にしました`
        : targetDb === 0
          ? '効果音を「自分の声と同じ大きさ」にしました'
          : targetDb < 0
            ? `効果音を自分の声より ${(-targetDb).toFixed(1)} dB 小さくしました`
            : `効果音を自分の声より ${targetDb.toFixed(1)} dB 大きくしました`
    set({ status: msg })
  },

  saveCalibration: (rec) => {
    set((st) => ({ settings: { ...st.settings, calibration: rec } }))
    void api?.saveConfig({ calibration: rec })
  }
  }
})
