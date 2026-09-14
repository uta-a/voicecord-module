import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, Gauge, Mic, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { engineApi, humanizeEngineMessage, useStore } from '@/store'
import { cn } from '@/lib/utils'
import { MASTER_MAX_DB, fmtDb, fmtDbfs, meterRatio, toDb, toLinear } from '@/lib/db'
import {
  TARGET_MAX_DB,
  TARGET_MIN_DB,
  currentTargetDb,
  medianDbfs,
  recommendMasterDb,
  recommendSourceVolume,
  recommendedTargetBand,
  targetRange,
  voiceMatchDb
} from '@/lib/calibration'
import { clampRefDbfs } from '@shared/loudness'
import type { SoundItem, SourceStats } from '@shared/types'
import { guardTrusted } from '@/lib/trusted'

// 「あー」と出し続けてもらう前提の長さ。長くすると息が続かず途中で切れ、
// 発話フレームが減って測定が不安定になる。
const MEASURE_SECONDS = 3
const SCAN_CONCURRENCY = 3 // ffmpeg 変換が走るので欲張らない

// スキャン結果はダイアログを閉じても保持する(Radix は閉じると中身をアンマウントするため、
// これが無いと開き直すたびに全件測り直しになる)。キーは内容指紋なので、ファイルを
// 差し替えれば自動的に測り直しになる。
const statsCache = new Map<string, SourceStats>()

// 読み取り専用のレベルメーター。-60..0 dBFS を 0..100% に線形マップする。
// components/ui/ は shadcn 生成物の置き場なので、手書きのこれはここに置く。
function LevelMeter({
  value,
  label,
  hot
}: {
  value: number
  label: string
  hot?: boolean
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-muted-foreground">{fmtDbfs(value)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full transition-[width] duration-75', hot ? 'bg-amber-500' : 'bg-primary')}
          style={{ width: `${meterRatio(value) * 100}%` }}
        />
      </div>
    </div>
  )
}

function CheckRow({ ok, children }: { ok: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
      ) : (
        <X className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <span className={ok ? '' : 'text-muted-foreground'}>{children}</span>
      <span className="sr-only">{ok ? '（条件を満たしています）' : '（条件を満たしていません）'}</span>
    </div>
  )
}

// 全音源のラウドネスを測って、基準レベルへ揃える音量を自動で書き込む。
// 基準は「測定値の中央値」。固定値だと録音レベルの偏ったフォルダで上限 150% に
// 張り付く音源が増えるが、中央値なら上下に振り分けられて頭打ちが最も少なくなる。
function useNormalizeScan(sounds: SoundItem[]): {
  stats: Record<string, SourceStats>
  scanning: boolean
  started: boolean
  done: number
  failed: number
  error: string
  refDbfs: number | null
  scan: () => void
  rescan: () => void
} {
  const setSourceVolume = useStore((s) => s.setSourceVolume)
  const setStatus = useStore((s) => s.setStatus)
  const patch = useStore((s) => s.patchSettings)
  const [stats, setStats] = useState<Record<string, SourceStats>>({})
  const [scanning, setScanning] = useState(false)
  // 一度でも走らせたか。未スキャンと「スキャンしたが 0 件」は見せるべきものが違う。
  const [started, setStarted] = useState(false)
  const [done, setDone] = useState(0)
  const [failed, setFailed] = useState(0)
  const [error, setError] = useState('')
  // 進行中のスキャンを識別する世代トークン。真偽値の abort フラグだと、React 18 の
  // StrictMode(effect実行 → cleanup → effect再実行)で cleanup が立てたフラグを
  // 再実行側が下ろせず、スキャンが即座に空振りして「測定できませんでした」になる。
  // 世代なら、新しい run が始まった時点で古い run だけが無効になる。
  const genRef = useRef(0)

  const run = async (): Promise<void> => {
    const gen = ++genRef.current
    const alive = (): boolean => genRef.current === gen
    setStarted(true)
    const api = engineApi
    if (!api) {
      setError('エンジンに接続されていません')
      return
    }
    if (sounds.length === 0) return
    setScanning(true)
    setDone(0)
    setFailed(0)
    setError('')
    const queue = [...sounds]
    const got: Record<string, SourceStats> = {}
    let bad = 0
    let firstErr = ''
    const worker = async (): Promise<void> => {
      for (;;) {
        if (!alive()) return
        const item = queue.shift()
        if (!item) return
        try {
          const cached = statsCache.get(item.fp)
          const st = cached ?? (await api.sourceStats(item.path))
          if (!alive()) return
          statsCache.set(item.fp, st)
          got[item.id] = st
          setStats((prev) => ({ ...prev, [item.id]: st }))
        } catch (e) {
          // 理由を捨てない。握り潰すと「使えない」としか分からなくなる。
          bad++
          // 生の英語(ffmpeg のログや frida のメッセージ)をそのまま画面へ出さない。
          // store と同じ写像を通し、対応できる文言は日本語にする。
          if (!firstErr) firstErr = `${item.id}: ${humanizeEngineMessage(String(e))}`
        }
        setDone((n) => n + 1)
      }
    }
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
    if (!alive()) return // 新しいスキャンに追い越された / アンマウントされた
    setFailed(bad)
    setError(firstErr)
    setScanning(false)
    const ref = medianDbfs(Object.values(got).map((s) => s.rms))
    if (ref === null) return
    // 保存側と同じ範囲へ先に収める。ここで収めないと、極端に静か／大きいフォルダで
    // 算出した基準が config.json への保存時に黙って矯正され、再起動の前後で推奨音量が
    // 変わる(触っていないのに値が変わる)。
    const rounded = clampRefDbfs(Math.round(ref * 10) / 10)
    const before = useStore.getState().settings
    const prevRef = before.normalizeRefDbfs
    patch({ normalizeRefDbfs: rounded })

    // 基準ラウドネスが動くと、送信音量を触っていなくても相手に届く「声との差」が変わる。
    // ユーザーが決めたのは「声より何 dB」であって送信ゲインそのものではないので、その差が
    // 保たれるように送信音量を計算し直す。これが無いと、校正を済ませた後にこのスキャンを
    // 走らせただけで相手への音量が黙ってズレる(この画面で最も踏みやすい経路だった)。
    //
    // 基準にするのは保存済みの calibration.targetDb ではなく**今の実際の差**。上部フェーダーで
    // 後から微調整した分は targetDb に書き戻らないため、保存値は「適用した瞬間の意図」でしか
    // なく、現在の設定とは平気で食い違う(実測で 6 dB ズレている環境があった)。保存値を
    // 使うと、スキャンしただけで手動調整が巻き戻る。
    // 自動で音量を書き込むのは「まだ音量が決まっていない音源」だけ(下のループ)。つまり
    // 既に音量がある音源は**旧基準のまま**残る。送信音量の式は「全音源が基準へ揃っている」
    // ことが前提なので、揃っていないのに master だけ動かすと、触っていない既存の効果音が
    // 相手側で基準の移動量ぶん大きく(小さく)なる。どれだけ取り残されるかを先に数える。
    const known = useStore.getState().sourceVolumes
    const stale = Object.entries(got).filter(([id, st]) => {
      const v = known[id]
      if (v === undefined) return false // これから自動で新基準へ揃える
      return Math.abs(recommendSourceVolume(st.rms, st.peak, rounded).vol - v) >= 0.005
    }).length

    const cal = before.calibration
    const prevMatch = cal ? voiceMatchDb(cal.voiceRms, prevRef) : null
    const curTarget = prevMatch === null ? null : currentTargetDb(toDb(before.master), prevMatch)
    const refMoved = Math.abs(rounded - prevRef) >= 0.05
    // 旧基準の音源が残っている間は master を動かさない。動かすと「差は保たれた」と言いながら
    // 実際には取り残された音源だけがズレる、いちばん気付けない壊れ方になる。
    const retuned =
      cal !== null && curTarget !== null && Number.isFinite(curTarget) && refMoved && stale === 0
    let clampedAt: 'min' | 'max' | undefined
    if (cal && retuned && curTarget !== null) {
      const next = recommendMasterDb(cal.voiceRms, rounded, curTarget)
      clampedAt = next.clampedAt
      useStore.getState().setMaster(toLinear(next.db))
    }

    // 自動で音量を書き込むのは「まだ音量が決まっていない音源」だけにする。
    // 全件へ適用すると、ユーザーが個別に設定した音量をこの画面を開いただけで破棄する
    // ことになる(取り消し手段も無い)。既に値がある音源は表に推奨値を並べるに留め、
    // 揃え直すかどうかは「すべての音源に音量を適用」に委ねる。
    let applied = 0
    for (const [id, st] of Object.entries(got)) {
      if (known[id] !== undefined) continue
      setSourceVolume(id, recommendSourceVolume(st.rms, st.peak, rounded).vol)
      applied++
    }
    // 起きたことは黙って済ませない。とくに送信音量の再計算は、ユーザーがこの画面で
    // 触っていないつまみが動く操作なので、必ず理由とセットで伝える。
    const notes: string[] = []
    if (applied > 0) notes.push(`${applied} 件のサウンドの音量を自動で揃えました`)
    if (retuned) {
      // 上限・下限で頭打ちになったなら「保たれた」と言ってはいけない(実際には保たれていない)。
      notes.push(
        clampedAt === undefined
          ? '基準が変わったため、送信音量を「声との差」が保たれる値に直しました'
          : `基準が変わりましたが、送信音量が${clampedAt === 'max' ? '上限' : '下限'}に達したため「声との差」を保てませんでした`
      )
    } else if (refMoved && stale > 0) {
      notes.push(
        `基準が変わりました。${stale} 件の音源が古い基準のままなので、「すべての音源に音量を適用」で揃えてください`
      )
    }
    if (notes.length > 0) setStatus(notes.join('。'))
  }

  // 開いただけでは走らせない。未変換の音源があると全件に ffmpeg が走る重い処理で、
  // 送信音量だけ見に来たユーザーにも待ちを強いるため、開始はボタンに委ねる。
  // アンマウント時は世代を進めて進行中の run を捨てる。
  useEffect(() => {
    return () => {
      genRef.current++
    }
  }, [])

  const refDbfs = useMemo(() => {
    const m = medianDbfs(Object.values(stats).map((s) => s.rms))
    return m === null ? null : clampRefDbfs(Math.round(m * 10) / 10)
  }, [stats])

  return {
    stats,
    scanning,
    started,
    done,
    failed,
    error,
    refDbfs,
    scan: () => {
      void run()
    },
    rescan: () => {
      statsCache.clear()
      setStats({})
      void run()
    }
  }
}

function LevelDialogBody(): React.JSX.Element {
  const attached = useStore((s) => s.attached)
  const connection = useStore((s) => s.connection)
  const voices = useStore((s) => s.voices)
  const sounds = useStore((s) => s.sounds)
  const settings = useStore((s) => s.settings)
  const sourceVolumes = useStore((s) => s.sourceVolumes)
  const setSourceVolume = useStore((s) => s.setSourceVolume)
  const calib = useStore((s) => s.calib)
  const startVoiceCalib = useStore((s) => s.startVoiceCalib)
  const cancelCalib = useStore((s) => s.cancelCalib)
  const applyMasterDb = useStore((s) => s.applyMasterDb)
  const saveCalibration = useStore((s) => s.saveCalibration)
  const stopAll = useStore((s) => s.stopAll)

  const norm = useNormalizeScan(sounds)
  const saved = settings.calibration
  // 初期値は「今この瞬間の実際の差」。保存済みの目標値を使うと、右レールが現在値
  // (例 -9.4 dB)を出しているのに、ダイアログのスライダーだけ保存値(例 ±0.0 dB)を指す。
  const [targetDb, setTargetDb] = useState<number>(() => {
    const m = settings.calibration
      ? voiceMatchDb(settings.calibration.voiceRms, settings.normalizeRefDbfs)
      : null
    if (m === null) return settings.calibration?.targetDb ?? 0
    const d = currentTargetDb(toDb(settings.master), m)
    return Number.isFinite(d) ? Math.round(d * 2) / 2 : 0
  })
  // 「声を出す準備ができた」状態。測定はボタンを押した瞬間から実時間で進むので、
  // 押す前に声を出し始められるよう、説明を読む段と開始する段を分ける。
  const [ready, setReady] = useState(false)
  // ユーザーがスライダーを触ったか。触った後は基準変更で値を上書きしない。
  const touchedRef = useRef(false)
  const playingNow = voices.some((v) => v.kind === 'vc')
  const canMeasure = attached && connection === 'connected' && !playingNow

  // 今回測ったものがあればそれを、無ければ保存済みを使う(目標を変えても測り直さずに
  // 推奨値を出し直せる)。
  const source =
    calib.phase === 'done' && calib.last
      ? { rms: calib.last.vRms, peak: calib.last.vPeak, fresh: true }
      : saved
        ? { rms: saved.voiceRms, peak: saved.voicePeak, fresh: false }
        : null

  const rec = source ? recommendMasterDb(source.rms, settings.normalizeRefDbfs, targetDb) : null
  const currentDb = toDb(settings.master)
  // 「声との差」はフェーダーと同じ原点・同じ範囲で扱う。範囲を絞らないと、送信ゲインの
  // 上限で届かない値まで掴めてしまい、適用後にフェーダーと違う数字が出る。
  const matchDb = source ? voiceMatchDb(source.rms, settings.normalizeRefDbfs) : null
  const range = matchDb !== null ? targetRange(matchDb) : null
  const targetMin = range ? range.min : TARGET_MIN_DB
  const targetMax = range ? range.max : TARGET_MAX_DB
  const currentTarget = matchDb !== null ? currentTargetDb(currentDb, matchDb) : null
  const zeroPct = ((0 - targetMin) / (targetMax - targetMin)) * 100
  // 推奨帯。可動域と重ならない環境では null になり、帯も説明も出さない。
  const band = recommendedTargetBand(targetMin, targetMax)

  // 初めて測定値が手に入った瞬間だけ、スライダーを「今の実際の差」に合わせる。
  // 未校正で開くと matchDb が null で初期値を決められないため、ここで一度だけ埋める。
  //
  // **測り直しでは絶対に動かさない。** matchDb は voiceMatchDb(声のRMS, 基準) なので、
  // 声を測り直すと当然変化する。以前はその変化にも追従して targetDb を「今の実差」に
  // 書き換えていたが、そうすると推奨送信音量 raw = matchDb + targetDb が必ず現在値と
  // 一致し、「この設定にする」が恒等変換になる。つまり、マイクの位置や入力音量を変えて
  // 測り直しても送信音量が 1 dB も動かず、声とのバランスがズレたまま固定されていた
  // (「校正しても効果音が大きすぎる」の直接の原因)。
  // targetDb はユーザーの意図(声より何 dB)なので、測定値が変わっても保持するのが正しい。
  const seededTarget = useRef(matchDb !== null)
  useEffect(() => {
    if (matchDb === null || seededTarget.current) return
    seededTarget.current = true
    if (touchedRef.current) return
    const d = currentTargetDb(currentDb, matchDb)
    if (Number.isFinite(d)) setTargetDb(Math.round(d * 2) / 2)
  }, [matchDb, currentDb])
  // 目標を適用したときに効果音が相手へ届くレベル。定義そのもの(声 × 10^(目標/20))だが、
  // 声と並べて見せることで「声を測る」と「効果音の音量」の対応が目に見えるようになる。
  const sfxRms = source ? source.rms * Math.pow(10, targetDb / 20) : 0

  const apply = (): void => {
    if (!rec || !source) return
    applyMasterDb(rec.db, targetDb)
    const m = calib.last
    // at は「いつ声を測ったか」。保存済みの測定値のまま目標(声との差)だけ変えて適用した
    // ときにも現在時刻で上書きしていたため、手順3の「◯◯ の測定値」が声の日時とずれて
    // 嘘になっていた。今回測っていない(source.fresh === false)なら元の at を持ち越す。
    // activeRatio も同じ測定に揃える。calib.last は phase を問わず直近の測定を指すので、
    // fresh でないときに参照すると別の測定(失敗した測定を含む)の値が 1 レコードに混ざる。
    saveCalibration({
      at: source.fresh ? Date.now() : (saved?.at ?? Date.now()),
      voiceRms: source.rms,
      voicePeak: source.peak,
      activeRatio:
        source.fresh && m && m.total > 0 ? m.vN / m.total : (saved?.activeRatio ?? 1),
      targetDb
    })
  }

  // 各音源の「測定値」「推奨音量」「今入っている音量」をまとめる。推奨は基準レベルから
  // 都度計算する(基準が変われば推奨も変わるため、保存はしない)。
  const measuredRows = sounds
    .map((s) => {
      const st = norm.stats[s.id]
      if (!st) return null
      return {
        sound: s,
        st,
        rec: recommendSourceVolume(st.rms, st.peak, settings.normalizeRefDbfs),
        applied: sourceVolumes[s.id] ?? 1
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
  const clampedMax = measuredRows.filter((r) => r.rec.clampedAt === 'max').length
  const clampedPeak = measuredRows.filter((r) => r.rec.clampedAt === 'peak').length
  // 推奨とズレている音源。手で音量をいじった後や、基準が変わった後に効いてくる。
  const outOfSync = measuredRows.filter((r) => Math.abs(r.rec.vol - r.applied) >= 0.005)

  // 手順3の「相手にはこう届きます」が成り立つ前提は「全音源が基準へ揃っていること」。
  // 以前は「一度も測っていない」ときしか断っていなかったが、前提が崩れるのはそれだけではない。
  // 既に音量が入っていた音源は自動適用の対象外なので推奨とズレたまま残り(outOfSync)、
  // 上限 150% やピーク制約で頭打ちになった音源は原理的に基準へ届かない(clampedMax/clampedPeak)。
  // どちらも予測より大きく(小さく)相手へ届くのに「声と同じ大きさで届きます」と断定していた。
  const predictNotes: string[] = []
  if (measuredRows.length === 0) {
    predictNotes.push(
      'まだ音源の音量を揃えていません。上の「1. 音源の音量を揃える」を実行するまでは、ここの予測と実際に鳴る音量がズレます。'
    )
  } else {
    if (outOfSync.length > 0) {
      predictNotes.push(
        `${outOfSync.length} 件の音源が推奨と違う音量のままです。上の「すべての音源に音量を適用」で揃えるまで、その音源にはここの予測が当てはまりません。`
      )
    }
    if (clampedMax + clampedPeak > 0) {
      predictNotes.push(
        `${clampedMax + clampedPeak} 件は上限やピークの制約で基準に届いていません。その音源はここの表示より小さく届きます。`
      )
    }
  }

  // 「測り直す」が押せない理由。畳んだ側(2 回目以降の常用画面)には CheckRow が無いため、
  // disabled の理由が画面のどこにも出ていなかった。
  const measureBlockReason = !attached
    ? 'Discord に接続してください'
    : connection !== 'connected'
      ? 'VC で通話を始めてください'
      : playingNow
        ? '再生中のサウンドがあります'
        : ''

  const applyAllSourceVolumes = (): void => {
    for (const r of measuredRows) setSourceVolume(r.sound.id, r.rec.vol)
  }

  // ---- 声を出す準備(開始タイミングはユーザーが決める) ----
  if (ready) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border bg-card p-6 text-center">
          <div className="text-sm font-medium">
            <span className="text-primary">「あー」</span>と声を出しながら
            <br />
            下のボタンを押してください
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            いつもの声の大きさ・いつものマイクの距離で。
            <br />
            押したあと {MEASURE_SECONDS} 秒間、途切れさせずに出し続けてください。
          </p>
          <Button
            className="mt-4 h-11 w-full text-sm"
            // 測定の開始は送信系の操作として扱う（ユーザーの決定）。合成クリックでは始めない
            onClick={guardTrusted('音量調整の測定開始', () => {
              setReady(false)
              startVoiceCalib(MEASURE_SECONDS)
            })}
          >
            <Mic className="h-4 w-4" aria-hidden="true" />
            測定を開始（{MEASURE_SECONDS} 秒）
          </Button>
        </div>
        <Button variant="outline" className="w-full" onClick={() => setReady(false)}>
          やめる
        </Button>
      </div>
    )
  }

  // ---- 計測中 ----
  if (calib.phase === 'measuring') {
    const pct = calib.budget > 0 ? Math.min(100, (calib.frames / calib.budget) * 100) : 0
    return (
      <div className="space-y-4">
        <div className="rounded-md border bg-card p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Mic className="h-4 w-4 text-primary" aria-hidden="true" />
            今すぐ<span className="text-primary">「あー」</span>と声を出してください
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground">
            下のバーが動いていれば声を拾えています。途切れさせずに出し続けてください。
          </p>
          <LevelMeter
            value={calib.vNow}
            label="あなたの声（相手に送られている音）"
            hot={calib.vNow >= 0.9}
          />
          <div className="mt-4">
            <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted-foreground">
              <span>測定の進み具合</span>
              <span className="font-mono tabular-nums">
                {calib.frames} / {calib.budget} フレーム
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              経過時間ではなく実際に処理されたマイクのフレーム数です。
              進まない場合はマイクがミュートになっています。
            </p>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={cancelCalib}>
          中断する
        </Button>
      </div>
    )
  }

  // 音源の均一化。**声の測定より前に置く**。この処理は基準レベル(normalizeRefDbfs)を
  // 確定させるもので、送信音量の推奨はその基準を使って計算される。声を先に測って適用させると、
  // 後からここを実行しただけで基準が動き、適用済みの送信音量が黙ってズレる
  // (= 校正したのに相手には効果音だけ大きい)。順序が依存関係を語るようにしておく。
  const normalizeSection = (
    <div className="rounded-md border bg-card p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold">1. 音源の音量を揃える</span>
        {!norm.scanning && measuredRows.length > 0 && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            基準 {norm.refDbfs?.toFixed(1)} dBFS
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        サウンドごとの音量差をならします。まだ音量を決めていないものは測定後に自動で揃え、
        個別に設定した音量はそのまま残します。次の「声を測る」はこの結果を基準にするので、
        先にこちらを済ませてください。
      </p>

      {norm.scanning ? (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted-foreground">
            <span>初回は音声の変換が走るため時間がかかります</span>
            <span className="font-mono tabular-nums">
              {norm.done} / {sounds.length}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary"
              style={{ width: `${sounds.length ? (norm.done / sounds.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : measuredRows.length > 0 ? (
        <>
          {/* Radix の Viewport 直下は display:table になり、中の table が shrink-to-fit で
              横幅を失う(EntrySoundDialog のリストで踏んだのと同じ問題)。!block に戻す。 */}
          <ScrollArea className="mt-3 h-[168px] rounded-md border [&>[data-radix-scroll-area-viewport]>div]:!block">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-toolbar text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">音源</th>
                  <th className="px-2 py-1.5 text-right font-medium">測定</th>
                  <th className="px-2 py-1.5 text-right font-medium">推奨</th>
                  <th className="px-3 py-1.5 text-right font-medium">現在</th>
                </tr>
              </thead>
              <tbody>
                {measuredRows.map((r) => {
                  const note =
                    r.rec.clampedAt === 'max'
                      ? '元の録音が小さすぎるため、上限の 150% でも基準に届きません'
                      : r.rec.clampedAt === 'peak'
                        ? 'ピークが高い音源のため、音割れを避けて基準より控えめにしています'
                        : undefined
                  const differs = Math.abs(r.rec.vol - r.applied) >= 0.005
                  return (
                    <tr key={r.sound.id} className="border-t">
                      <td className="max-w-0 px-3 py-1">
                        <div className="truncate" title={r.sound.name}>
                          {r.sound.id}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {fmtDbfs(r.st.rms)}
                      </td>
                      <td
                        className={cn(
                          'whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums',
                          r.rec.clampedAt ? 'text-amber-500' : 'text-muted-foreground'
                        )}
                        title={note}
                      >
                        {Math.round(r.rec.vol * 100)}%{r.rec.clampedAt && ' ⚠'}
                      </td>
                      {/* 実際に効いている値なので右端に置き、推奨とズレていれば強調する。 */}
                      <td
                        className={cn(
                          'whitespace-nowrap px-3 py-1 text-right font-mono tabular-nums',
                          differs && 'text-primary'
                        )}
                      >
                        {Math.round(r.applied * 100)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollArea>
          {clampedMax > 0 && (
            <p className="mt-2 text-[11px] text-amber-500">
              ⚠ の {clampedMax} 件は上限（150%）で頭打ちです。元の録音が小さすぎます。
            </p>
          )}
          {clampedPeak > 0 && (
            <p className="mt-2 text-[11px] text-amber-500">
              ⚠ の {clampedPeak} 件はピークが高いため、音割れを避けて基準より控えめにしています。
            </p>
          )}
          {norm.failed > 0 && (
            <p className="mt-2 break-all text-[11px] text-amber-500">
              {norm.failed} 件を測定できませんでした。{norm.error}
            </p>
          )}
          {/* 測定の直後は未設定の音源へ自動適用済みなので、通常はすべて推奨値どおりに
              なっている。個別に音量をいじった場合や基準が変わった場合だけ、戻す手段として
              ボタンを出す(押しても何も変わらないボタンを常に置いておかない)。 */}
          {outOfSync.length > 0 ? (
            <Button className="mt-3 w-full" onClick={applyAllSourceVolumes}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              すべての音源に音量を適用（{outOfSync.length} 件を変更）
            </Button>
          ) : (
            <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
              すべて推奨値どおりです
            </p>
          )}
          <Button variant="outline" className="mt-2 w-full" onClick={norm.rescan}>
            測り直す
          </Button>
        </>
      ) : norm.started || sounds.length === 0 ? (
        <>
          <p className="mt-3 break-all text-[11px] text-amber-500">
            {sounds.length === 0
              ? 'サウンドフォルダに音源がありません。'
              : `測定できませんでした。${norm.error}`}
          </p>
          {/* 全件失敗するとこの枝が終端になり、「測る」も「測り直す」も画面から消えて、
              ダイアログを閉じて開き直す(= started が false に戻る)以外に再試行できなかった。
              失敗は一過性(ffmpeg 実体パスの解決失敗、一時的な detach、初回変換のタイムアウト)
              でも起きるので、回復操作を必ず残す。 */}
          {sounds.length > 0 && (
            <Button variant="outline" className="mt-2 w-full" onClick={norm.rescan}>
              <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
              もう一度測る
            </Button>
          )}
        </>
      ) : (
        <>
          <Button className="mt-3 w-full" onClick={norm.scan}>
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            {sounds.length} 件のサウンドを測る
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground">
            初回は音声の変換が走るため時間がかかります。VC へは何も送られません。
          </p>
        </>
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      {calib.phase === 'failed' && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>{calib.message || '測定に失敗しました'}</span>
        </div>
      )}
      {calib.phase === 'done' && calib.message && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <span>{calib.message}</span>
        </div>
      )}

      {normalizeSection}

      {/* ---- 手順2: 声を測る ----
          測定値がある間は1行に畳む。畳まないと手順3の「この設定にする」が
          既定ウィンドウ(720px)で画面外に落ち、「適用ボタンが無い」ように見える。
          今回測った場合(fresh)だけでなく、保存済みの測定値で開いた 2 回目以降も畳む
          (そちらの方が普通の経路で、実測では apply ボタンの上 24px しか見えなかった)。 */}
      {source ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
            {/* 畳んでも番号は残す。消すと見出しが 1 → 3 に飛び、手順が 1 つ抜けたように見える。 */}
            <span className="shrink-0">
              <span className="text-muted-foreground">2. </span>
              {source.fresh ? '声を測りました' : '測定ずみの声'}
            </span>
            <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
              {fmtDbfs(source.rms)}
            </span>
          </div>
          {/* 畳んだ側は「測り直す」1 つだけで、押せない理由(未接続 / VC 未参加 / 再生中)も
              再生中の逃げ道も落ちていた。畳まれる側こそ 2 回目以降の常用画面なので、
              CheckRow と同じ情報をここにも出す。disabled な button には Chromium が
              マウスイベントを配送せず title が読めないため、理由はボタンの外側に置き、
              aria-describedby でボタンと結び付ける。 */}
          <div className="flex shrink-0 items-center gap-2">
            {measureBlockReason && (
              <span id="remeasure-reason" className="text-[11px] text-muted-foreground">
                {measureBlockReason}
              </span>
            )}
            {playingNow && (
              <Button variant="outline" size="sm" onClick={stopAll}>
                停止して続行
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canMeasure}
              aria-describedby={measureBlockReason ? 'remeasure-reason' : undefined}
              onClick={() => setReady(true)}
            >
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              測り直す
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border bg-card p-4">
          <div className="mb-2.5 text-xs font-semibold">2. 自分の声を測る</div>
          <div className="space-y-2">
            <CheckRow ok={attached}>Discord に接続している</CheckRow>
            <CheckRow ok={connection === 'connected'}>VC で通話中である</CheckRow>
            <CheckRow ok={!playingNow}>再生中のサウンドがない</CheckRow>
          </div>
          <p className="pt-2 text-[11px] text-muted-foreground">
            「あー」と {MEASURE_SECONDS} 秒間、声を切らさずに出し続けてもらいます。
            開始のタイミングは次の画面で自分で決められます。
            測定中に VC へ音が送られることはありません。送信ゲートにも触れません。
          </p>
          <div className="flex gap-2 pt-2.5">
            <Button
              className="flex-1"
              disabled={!canMeasure}
              onClick={() => setReady(true)}
            >
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              「あー」と {MEASURE_SECONDS} 秒間、声を出す
            </Button>
            {playingNow && (
              <Button variant="outline" onClick={stopAll}>
                停止して続行
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ---- 手順3: 効果音をどれくらいで届けるか ---- */}
      {source && rec && (
        <div className="rounded-md border bg-card p-4">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-semibold">3. 効果音の大きさを決める</span>
            {!source.fresh && saved && (
              <span className="text-[11px] text-muted-foreground">
                {new Date(saved.at).toLocaleString()} の測定値
              </span>
            )}
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground">
            測った声を基準に、効果音を相手へどのくらいの大きさで届けるかを選びます。
          </p>

          {/* 声と効果音を同じ目盛りで並べる。これが「声 → 効果音」の対応そのもの。 */}
          <div className="space-y-2.5 rounded-md bg-background/60 p-3">
            <div className="text-[11px] font-medium">相手にはこう届きます</div>
            {/* この予測は「音源が基準レベルへ揃っている」ことが前提(calibration.ts の式を参照)。
                揃っていない音源(未測定 / 推奨とズレたまま / 頭打ち)はこの数値と実際に鳴る
                音量がズレる。押させない(disabled)のではなく警告に留めるのは、apply() が
                sourceVolumes に触らず master の計算自体は破綻しないため。「先に声との
                バランスだけ決めて均一化は後で」も正当な使い方なので塞がない。 */}
            {predictNotes.map((note) => (
              <p key={note} className="flex items-start gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{note}</span>
              </p>
            ))}
            <LevelMeter value={source.rms} label="あなたの声" />
            <LevelMeter value={sfxRms} label="効果音" hot={targetDb > 0} />
            <p className="pt-0.5 text-[11px] text-muted-foreground">
              {targetDb === 0
                ? '効果音は自分の声と同じ大きさで届きます。'
                : targetDb < 0
                  ? `効果音は自分の声より ${(-targetDb).toFixed(1)} dB 小さく届きます。`
                  : `効果音は自分の声より ${targetDb.toFixed(1)} dB 大きく届きます。`}
            </p>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-baseline justify-between text-xs font-medium">
              <span>声との差</span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {fmtDb(targetDb)}
              </span>
            </div>
            <div className="relative">
              <Slider
                aria-label="効果音と声の音量差"
                value={[Math.min(targetMax, Math.max(targetMin, targetDb))]}
                min={targetMin}
                max={targetMax}
                step={0.5}
                onValueChange={([v]) => {
                  touchedRef.current = true
                  setTargetDb(v!)
                }}
              />
              {/* 0 dB(= 声と同じ大きさ)の位置に目盛り。左右で意味が反転する境目なので示す。
                  色は TopBar のフェーダーと同じ理由で背景色(塗りの上でも埋もれない)。 */}
              <span
                className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-background"
                style={{ left: `${zeroPct}%` }}
                aria-hidden="true"
              />
            </div>
            {/* 推奨帯。0 dB は「RMS が声と同じ」であって「同じ大きさに聞こえる」ではないので、
                目盛りだけだと 0 に合わせたくなる。まず試す範囲を面で示す。
                トラックの上に重ねると塗り(primary)とつまみに埋もれるので、真下に敷いて
                同じ座標系(targetMin..targetMax)で位置を合わせる。 */}
            {band && (
              <div className="relative mt-1 h-1" aria-hidden="true">
                <span
                  className="absolute inset-y-0 rounded-full bg-emerald-500/70"
                  style={{
                    left: `${((band.min - targetMin) / (targetMax - targetMin)) * 100}%`,
                    width: `${((band.max - band.min) / (targetMax - targetMin)) * 100}%`
                  }}
                />
              </div>
            )}
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>控えめ</span>
              <span>目立たせる</span>
            </div>
            {band && (
              <div className="mt-2 rounded-md bg-background/60 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span
                      className="h-1.5 w-4 shrink-0 rounded-full bg-emerald-500/50"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground">
                      おすすめ {fmtDb(band.min)} 〜 {fmtDb(band.max)}
                    </span>
                  </span>
                  {Math.abs(targetDb - band.center) >= 0.5 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-[11px]"
                      onClick={() => {
                        touchedRef.current = true
                        setTargetDb(band.center)
                      }}
                    >
                      {fmtDb(band.center)} にする
                    </Button>
                  )}
                </div>
                {/* なぜ 0 dB が推奨でないのかを書く。書かないと「声と同じ」が最も無難に見え、
                    実際にはそこが相手にとって最も大きい設定になる。 */}
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  ±0 dB は「声と同じ音量」ではなく「声と同じ RMS」です。声は絶えず途切れるのに
                  効果音は鳴り続けるため、同じ RMS だと効果音のほうがはっきり大きく聞こえます。
                </p>
              </div>
            )}
          </div>

          {/* 変更の前後を「声との差」で見せる。生の送信ゲインは UI のどこにも出ていない
              内部量なので、ここに出すとフェーダーやトーストと別の数字が並んでしまう。 */}
          <div className="mt-3 flex items-center justify-between rounded-md border bg-background/60 px-3 py-2.5">
            <span className="text-xs">声との差</span>
            <span className="flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className="text-muted-foreground">
                {currentTarget !== null ? fmtDb(currentTarget) : fmtDb(currentDb)}
              </span>
              <ArrowRight className="h-3.5 w-3.5 self-center text-muted-foreground" aria-hidden="true" />
              <span className="text-primary">{fmtDb(targetDb)}</span>
            </span>
          </div>
          {rec.clampedAt === 'max' && (
            <p className="mt-2 text-[11px] text-amber-500">
              上限（{MASTER_MAX_DB} dB）に達しました。マイク入力が大きいため、これ以上は
              効果音を持ち上げられません。Discord の入力音量を下げてください。
            </p>
          )}
          {rec.clampedAt === 'min' && <p className="mt-2 text-[11px] text-amber-500">下限に達しました。</p>}

          {/* 基準レベルはスキャン完了時に確定する。それより前に適用すると古い基準で
              計算した送信音量が入り、直後のスキャン完了で全音源が動いてズレる。 */}
          <Button className="mt-3 w-full" onClick={apply} disabled={norm.scanning}>
            {norm.scanning ? 'サウンドの測定を待っています…' : 'この設定にする'}
          </Button>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2.5 text-[11px]">
            <dt className="text-muted-foreground">測った声（RMS）</dt>
            <dd className="text-right font-mono tabular-nums">{fmtDbfs(source.rms)}</dd>
            <dt className="text-muted-foreground">同（ピーク）</dt>
            <dd className="text-right font-mono tabular-nums">{fmtDbfs(source.peak)}</dd>
            {source.fresh && calib.last && calib.last.clip > 0 && (
              <>
                <dt className="text-muted-foreground">クリップ（音割れ）</dt>
                <dd className="text-right font-mono tabular-nums text-amber-500">
                  {calib.last.clip} サンプル
                </dd>
              </>
            )}
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">
            測定できるのは「あなたの PC から出ていく時点」の声と効果音の比です。
            相手側の受信音量設定までは分かりません。
          </p>
        </div>
      )}

    </div>
  )
}

export function LevelDialog(): React.JSX.Element {
  const open = useStore((s) => s.levelOpen)
  const setOpen = useStore((s) => s.setLevelOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" aria-hidden="true" />
            音量調整
          </DialogTitle>
          <DialogDescription>
            相手に送られている音を実測して、この環境に合った音量を決めます。
          </DialogDescription>
        </DialogHeader>
        {open && <LevelDialogBody />}
      </DialogContent>
    </Dialog>
  )
}
