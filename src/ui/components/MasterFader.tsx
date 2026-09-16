import { Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { MASTER_MAX_DB, MASTER_MIN_DB, fmtDb, toDb, toLinear } from '@/lib/db'
import { currentTargetDb, targetRange, voiceMatchDb } from '@/lib/calibration'
import { useStore } from '@/store'

/**
 * 全体音量のフェーダー。移植元では TopBar にあったものを、ポップアウトの下端へ移した。
 *
 * 校正済みなら「効果音が声と同じ大きさで届く点」を 0 dB とする相対フェーダーにする。
 * 生の送信ゲイン(+6.9 dB など)はユーザーにとって意味の無い数値で、知りたいのは
 * 「声よりどれだけ大きい/小さいか」なので、そちらを直接動かせるようにする。
 *
 * 原点は clamp しない voiceMatchDb を使う。clamp 済みの値を原点にすると、実際の到達
 * レベルから逆算する設定画面の表示と食い違う(声が大きい環境で 6dB ずれた)。
 */
export function MasterFader({ className }: { className?: string }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setMaster = useStore((s) => s.setMaster)
  const setMasterLive = useStore((s) => s.setMasterLive)
  const setLevelOpen = useStore((s) => s.setLevelOpen)
  const saveCalibration = useStore((s) => s.saveCalibration)
  const cal = settings.calibration
  const masterDb = toDb(settings.master)
  const matchDb = cal ? voiceMatchDb(cal.voiceRms, settings.normalizeRefDbfs) : null
  const range = matchDb !== null ? targetRange(matchDb) : null
  const rel = matchDb !== null && range !== null
  const faderMin = rel ? range.min : MASTER_MIN_DB
  const faderMax = rel ? range.max : MASTER_MAX_DB
  const faderValue = rel ? currentTargetDb(masterDb, matchDb) : masterDb
  const shownValue = Number.isFinite(faderValue)
    ? Math.min(faderMax, Math.max(faderMin, faderValue))
    : faderMin
  const zeroPct = ((0 - faderMin) / (faderMax - faderMin)) * 100

  return (
    <div
      className={cn('flex min-w-0 flex-col justify-center gap-1', className)}
      title={
        rel
          ? '効果音を自分の声より何 dB 大きく／小さく相手へ届けるか。0 dB で声と同じ大きさです。試聴やモニターで自分に聞こえる音にも同じだけ掛かります。'
          : '送信ゲイン — 相手に聞こえる音量です（試聴やモニターにも掛かります）。音量調整で声を測ると「声との差」で調整できるようになります。'
      }
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
        <span className="truncate text-muted-foreground">
          {rel ? '全体音量' : '全体音量（未校正）'}
        </span>
        <span
          className={cn(
            'shrink-0 font-mono tabular-nums',
            faderValue > 0.05 ? 'text-warning' : 'text-muted-foreground'
          )}
        >
          {fmtDb(faderValue)}
        </span>
      </div>
      <div className="flex items-center gap-2">
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
            aria-label={rel ? '全体音量（声との差）' : '全体音量'}
            value={[shownValue]}
            min={faderMin}
            max={faderMax}
            step={0.5}
            // ドラッグ中は音だけ変え、保存は指を離したとき(config.json への同期書き込みを抑える)
            onValueChange={([value]) => setMasterLive(toLinear(rel ? matchDb + value! : value!))}
            onValueCommit={([value]) => {
              setMaster(toLinear(rel ? matchDb + value! : value!))
              // 相対モードでは校正の記録側にも書き戻す。ズレたままだと基準ラウドネスが
              // 変わったときの再計算で手動調整が巻き戻る
              if (rel && cal) saveCalibration({ ...cal, targetDb: value! })
            }}
          />
          {/* 0 dB の位置の目盛り。塗りの上でも素のトラックの上でも見える背景色 */}
          <span
            className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-background"
            style={{ left: `${zeroPct}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  )
}
