import { Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SettingsRow } from '@/components/SettingsRow'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { fmtDb, toDb } from '@/lib/db'
import { currentTargetDb, recommendMasterDb, voiceMatchDb } from '@/lib/calibration'

/**
 * 設定画面(歯車)のうち、送信音量とモニターのセクション。
 * 使う頻度が高いので、設定画面の先頭に置かれる。
 */

export function VolumeSection(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const setLevelOpen = useStore((state) => state.setLevelOpen)
  const applyMasterDb = useStore((state) => state.applyMasterDb)

  const cal = settings.calibration
  const masterDb = toDb(settings.master)
  // 「声との差」はフッターのフェーダーと同じヘルパーを通す(式を二重に書かない)。
  const matchDb = cal ? voiceMatchDb(cal.voiceRms, settings.normalizeRefDbfs) : null
  const diffDb =
    matchDb !== null && Number.isFinite(masterDb) ? currentTargetDb(masterDb, matchDb) : null
  // 声とぴったり一致させる送信音量。既に一致していれば行を出さない。
  const restoreDb =
    cal && matchDb !== null && diffDb !== null && Math.abs(diffDb) >= 0.05
      ? recommendMasterDb(cal.voiceRms, settings.normalizeRefDbfs, 0).db
      : null

  return (
    <section aria-label="音量">
      <h3 className="text-xs font-semibold text-muted-foreground">音量</h3>
      <div>
        {/* 未校正のときは「声との差」の数値を出さない。基準になる声を測っていない段階の
            「±0.0 dB」は相手にどう届くかを何も語らず、しかも「調整済み」に見えてしまう。 */}
        <SettingsRow
          label="声の大きさに合わせる"
          description={
            cal ? (
              <span title="効果音を自分の声より何 dB 大きく／小さく相手へ届けるか。フッターのフェーダーと同じ値です。">
                声との差{' '}
                <span
                  className={cn(
                    'font-mono tabular-nums',
                    diffDb !== null && Math.abs(diffDb) < 0.05 ? 'text-success' : 'text-primary'
                  )}
                >
                  {fmtDb(diffDb ?? masterDb)}
                </span>
              </span>
            ) : (
              'まだ声を測っていません。効果音が相手にどの大きさで届くかは未調整です'
            )
          }
          control={
            // 初めてのユーザーは自分のモニターで聞こえる音だけを頼りに「ちょうどいい」と
            // 判断してしまい、押す理由を持たない。未校正のときだけ塗りで示す
            // (校正後は測り直しが常時必要な操作ではないので outline に落とす)。
            <Button
              size="sm"
              variant={cal ? 'outline' : 'default'}
              onClick={() => setLevelOpen(true)}
              title={
                cal
                  ? '声の測定をやり直したり、音源ごとの音量を揃え直したりできます。'
                  : 'モニターには自分の声が入らないので、声とのバランスは耳では確かめられません。'
              }
            >
              <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
              {cal ? '音量調整を開く' : '音量を調整'}
            </Button>
          }
        />
        {restoreDb !== null && (
          <SettingsRow
            label="声と同じ大きさに戻す"
            control={
              <Button
                variant="outline"
                size="sm"
                aria-label="声と同じ大きさに戻す"
                onClick={() => applyMasterDb(restoreDb, 0)}
              >
                戻す
              </Button>
            }
          />
        )}
      </div>
    </section>
  )
}

export function MonitorSection(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patch = useStore((state) => state.patchSettings)
  const devices = useStore((state) => state.devices)

  return (
    <section aria-label="モニター">
      <h3 className="text-xs font-semibold text-muted-foreground">モニター</h3>
      <div>
        <SettingsRow
          label="自分の端末でも聴く"
          description="効果音を自分の出力デバイスでも鳴らします。相手に届く音は変わりません"
          control={
            <Switch
              aria-label="自分の端末でも聴く"
              checked={settings.sidetoneEnabled}
              onCheckedChange={(checked) => patch({ sidetoneEnabled: checked })}
            />
          }
        />
        {/* 出力デバイスと音量は試聴にも使うので、モニターが OFF でも操作できるままにする。 */}
        <SettingsRow
          label="出力デバイス"
          description="モニターと試聴の出力先です。モニターが OFF でも試聴に使います"
          control={
            <Select
              value={settings.sidetoneDevice || 'default'}
              onValueChange={(value) => patch({ sidetoneDevice: value === 'default' ? '' : value })}
            >
              <SelectTrigger aria-label="モニター出力デバイス" className="h-9 w-52 bg-background/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">既定デバイス</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label="モニター音量"
          description="モニターと試聴の音量です。モニターが OFF でも試聴に効きます。相手に届く音量は変わりません"
        >
          <div className="flex items-center gap-3">
            <Slider
              aria-label="モニター音量"
              className="flex-1"
              value={[settings.sidetoneVolume * 100]}
              min={0}
              max={100}
              step={1}
              onValueChange={([value]) => patch({ sidetoneVolume: value! / 100 })}
            />
            <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {Math.round(settings.sidetoneVolume * 100)}%
            </span>
          </div>
        </SettingsRow>
      </div>
    </section>
  )
}
