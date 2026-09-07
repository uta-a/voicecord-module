import { useState } from 'react'
import { AudioLines, DoorOpen, Mic, Plug, Square, Volume2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { EntrySoundDialog } from '@/components/EntrySoundDialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { MASTER_MAX_DB, MASTER_MIN_DB, fmtDb, toDb, toLinear } from '@/lib/db'
import { currentTargetDb, targetRange, voiceMatchDb } from '@/lib/calibration'
import { useStore } from '@/store'
import { BUILD_LABEL, BUILD_ORDER, type BuildKey, type ConnState } from '@shared/types'

const CONNECTION: Record<
  ConnState,
  { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }
> = {
  connected: { label: 'VC接続済', variant: 'success' },
  waiting: { label: 'VC待機中', variant: 'warning' },
  switching: { label: '切替中', variant: 'secondary' },
  disconnected: { label: '未接続', variant: 'destructive' }
}

// 送信ゲートが開いている間は、効果音だけでなく実マイク音声も Discord 側のミュート/VAD を
// 無視して相手へ流れる。最も危険な状態なので、トーストではなく常時可視の場所に出す。
const MIC_TRANSMIT: Record<'open' | 'unknown', { label: string; className: string; title: string }> =
  {
    open: {
      label: 'マイク送信中',
      className: 'border-destructive/60 bg-destructive/15 text-destructive',
      title:
        'Discord のミュートや音声検出の設定を無視して、マイクの音がそのまま相手へ届いています。効果音の再生が終わると自動で戻ります。'
    },
    unknown: {
      label: 'マイク状態不明',
      className: 'border-amber-500/60 bg-amber-500/15 text-amber-500',
      title:
        'Discord との接続が切れたため、マイクが常時送信のままかどうかを確認できません。再接続すると自動で元に戻ります。'
    }
  }

export function TopBar(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const micTransmit = useStore((s) => s.micTransmit)
  const detail = useStore((s) => s.connectionDetail)
  const build = useStore((s) => s.build)
  const setBuild = useStore((s) => s.setBuild)
  const connect = useStore((s) => s.connect)
  const settings = useStore((s) => s.settings)
  const master = settings.master
  const cal = settings.calibration
  const setMaster = useStore((s) => s.setMaster)
  const setMasterLive = useStore((s) => s.setMasterLive)
  const stopAll = useStore((s) => s.stopAll)
  const setLevelOpen = useStore((s) => s.setLevelOpen)
  const saveCalibration = useStore((s) => s.saveCalibration)
  const entryEnabled = useStore((s) => s.settings.entrySoundEnabled)
  const entrySrcId = useStore((s) => s.settings.entrySoundSrcId)
  const [entryOpen, setEntryOpen] = useState(false)
  const state = CONNECTION[connection]
  const mic = micTransmit === 'closed' ? null : MIC_TRANSMIT[micTransmit]
  const masterDb = toDb(master)
  // 校正済みなら「効果音が声と同じ大きさで届く点」を 0 dB とする相対フェーダーにする。
  // 生の送信ゲイン(+6.9 dB など)はユーザーにとって意味の無い数値で、知りたいのは
  // 「声よりどれだけ大きい/小さいか」なので、そちらを直接動かせるようにする。
  //
  // 原点は clamp しない voiceMatchDb を使う。clamp 済みの値を原点にすると、実際の到達
  // レベルから逆算する右レールの表示と食い違う(声が大きい環境で 6dB ずれた)。
  // 届かない領域はフェーダーの範囲(targetRange)側で表現する。
  const matchDb = cal ? voiceMatchDb(cal.voiceRms, settings.normalizeRefDbfs) : null
  const range = matchDb !== null ? targetRange(matchDb) : null
  const rel = matchDb !== null && range !== null
  const faderMin = rel ? range.min : MASTER_MIN_DB
  const faderMax = rel ? range.max : MASTER_MAX_DB
  const faderValue = rel ? currentTargetDb(masterDb, matchDb) : masterDb
  const shownValue = Number.isFinite(faderValue)
    ? Math.min(faderMax, Math.max(faderMin, faderValue))
    : faderMin
  // フェーダー上での 0 dB の位置(相対なら「声と同じ」、絶対なら従来の 100%)。
  const zeroPct = ((0 - faderMin) / (faderMax - faderMin)) * 100
  // 有効でも音源が未選択なら鳴らない。OFF と同じ表示にすると、トグルを ON にしたユーザーが
  // 「ON なのに OFF と出る」と混乱するので、未設定を独立した状態として出す。
  const entryState = !entryEnabled ? 'off' : entrySrcId === '' ? 'unset' : 'on'
  const ENTRY_DOT = { on: 'bg-emerald-600', unset: 'bg-amber-500', off: 'bg-muted-foreground/40' }
  const entryLabel = entryState === 'on' ? entrySrcId : entryState === 'unset' ? '入場音 未設定' : '入場音 OFF'

  return (
    // 列は 5 つ。EntrySoundDialog は Radix の Dialog.Root で DOM を持たないため、
    // 開閉に関わらずグリッドアイテムを消費しない。6 列にしておくと空の列との間の
    // gap だけが消費され、最小幅で右端のボタンがはみ出す原因になる。
    <header className="grid h-16 shrink-0 grid-cols-[minmax(180px,1fr)_auto_240px_auto_auto] items-center gap-3 border-b bg-toolbar px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary">
          <AudioLines className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold">VOICECORD</div>
          <div className="flex min-w-0 items-center gap-2">
            {/* 状態が変わったことを読み上げさせる。connectionDetail(PID 等)は頻繁に
                書き換わって読み上げが煩雑になるので、この live region には入れない。 */}
            <span className="flex shrink-0 items-center gap-2" aria-live="polite">
              <Badge variant={state.variant} className="h-5 shrink-0 px-2 py-0">
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                {state.label}
              </Badge>
              {mic && (
                <span
                  className={cn(
                    'flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
                    mic.className
                  )}
                  title={mic.title}
                >
                  <Mic className="h-3 w-3" aria-hidden="true" />
                  {mic.label}
                </span>
              )}
            </span>
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={detail}>
              {detail}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Select value={build} onValueChange={(value) => setBuild(value as BuildKey)}>
          <SelectTrigger className="h-9 w-[130px] bg-background/60" aria-label="Discordビルド">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUILD_ORDER.map((key) => (
              <SelectItem key={key} value={key}>
                {BUILD_LABEL[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 接続は起動時とビルド切替時に自動で走る。これはそれが失敗したとき(VoiceCord を
            Discord より先に起動した場合など)の予備で、繋がっている間は出さない。
            試行中も出したままにしないと、押した直後にボタンが消えて反応が分からなくなる。 */}
        {connection !== 'connected' && connection !== 'waiting' && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            disabled={connection === 'switching'}
            onClick={() => void connect(build)}
            title="Discord への接続をやり直します。VoiceCord を先に起動した場合など、自動接続に失敗したときに使ってください。"
          >
            <Plug className="h-3.5 w-3.5" aria-hidden="true" />
            {connection === 'switching' ? '接続中…' : '接続'}
          </Button>
        )}
      </div>

      {/* 縦に 2 段。1 段だとフェーダーの名前を置く幅が無く、アイコンとつまみと数字だけが
          並ぶ。この数字は校正の前後で意味が変わる(未校正=送信ゲインの絶対値 / 校正済み=
          声との差)ので、名前が見えていないと同じ場所の同じ数字が別のことを指していても
          気付けない。title は当てないと読めず、常時可視にする価値がある。 */}
      <div
        className="flex min-w-0 flex-col justify-center gap-1"
        title={
          rel
            ? '効果音を自分の声より何 dB 大きく／小さく相手へ届けるか。0 dB で声と同じ大きさです。試聴やモニターで自分に聞こえる音にも同じだけ掛かります。'
            : '送信ゲイン — 相手に聞こえる音量です（試聴やモニターにも掛かります）。音量調整で声を測ると「声との差」で調整できるようになります。'
        }
      >
        <div className="flex items-baseline justify-between gap-2 text-[10px] leading-none">
          <span className="truncate text-muted-foreground">
            {rel ? '効果音と声の差' : '送信ゲイン（未校正）'}
          </span>
          <span
            className={cn(
              'shrink-0 font-mono tabular-nums',
              faderValue > 0.05 ? 'text-amber-500' : 'text-muted-foreground'
            )}
          >
            {fmtDb(faderValue)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* 音量調整ダイアログへの導線。フェーダー本体をクリック対象にすると、Radix Slider の
              ドラッグとクリックの判別が要り、「少し動かしたつもりがダイアログが開く」を作る。
              隣のアイコンなら手数は同じ 1 回でそのリスクが無い。 */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setLevelOpen(true)}
            aria-label="音量調整を開く"
            title="声とのバランスを測って、送信音量と音源ごとの音量を調整します"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Volume2 className="h-4 w-4" />
          </Button>
          <div className="relative min-w-0 flex-1">
            <Slider
              aria-label={rel ? '効果音と声の音量差' : '送信ゲイン'}
              value={[shownValue]}
              min={faderMin}
              max={faderMax}
              step={0.5}
              // ドラッグ中は音だけ変え、保存は指を離したとき。onValueChange は pointermove ごとに
              // 飛ぶので、ここで保存すると config.json への同期書き込みが数十回走る。
              onValueChange={([value]) => setMasterLive(toLinear(rel ? matchDb + value! : value!))}
              onValueCommit={([value]) => {
                setMaster(toLinear(rel ? matchDb + value! : value!))
                // 相対モードでは、このフェーダーが動かしているのは「声との差」そのもの。
                // 校正の記録側にも書き戻さないと、保存値は「適用した瞬間の意図」で凍りつき、
                // ここで微調整した分だけ現在の設定と食い違う。基準ラウドネスが変わったときの
                // 再計算はこの値を手掛かりにするので、ズレたままだと手動調整が巻き戻る。
                if (rel && cal) saveCalibration({ ...cal, targetDb: value! })
              }}
            />
            {/* 0 dB(従来の 100%)の位置に目盛り。ここより右は送信ヘッドルームを削る領域。
                色は背景色。0dB より上に上げると目盛りが塗りつぶし(primary)の中に入るため、
                薄いグレーだと紫に埋もれて見えなくなる。暗い色なら塗りの上でも素の
                トラックの上でも判別できる。 */}
            <span
              className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-background"
              style={{ left: `${zeroPct}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => setEntryOpen(true)}
        className="h-9 max-w-[190px] justify-start gap-2"
        aria-label="入場サウンドの設定を開く"
        title="入場サウンドの設定"
      >
        <DoorOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', ENTRY_DOT[entryState])}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate font-normal">{entryLabel}</span>
      </Button>

      <Button variant="destructive" size="sm" onClick={stopAll} className="h-9">
        <Square className="h-3.5 w-3.5" aria-hidden="true" />
        全停止
      </Button>

      <EntrySoundDialog open={entryOpen} onOpenChange={setEntryOpen} />
    </header>
  )
}
