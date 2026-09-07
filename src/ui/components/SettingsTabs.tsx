import { Gauge, Headphones } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { fmtDb, toDb } from '@/lib/db'
import { currentTargetDb, recommendMasterDb, voiceMatchDb } from '@/lib/calibration'

function ControlLabel({ children, value }: { children: React.ReactNode; value?: string }): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between text-xs font-medium">
      <span>{children}</span>
      {value && <span className="font-mono text-[11px] text-muted-foreground">{value}</span>}
    </div>
  )
}

export function SettingsTabs(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patch = useStore((state) => state.patchSettings)
  const devices = useStore((state) => state.devices)
  const setLevelOpen = useStore((state) => state.setLevelOpen)
  const applyMasterDb = useStore((state) => state.applyMasterDb)

  const cal = settings.calibration
  const masterDb = toDb(settings.master)
  // 「声との差」は TopBar のフェーダーと同じヘルパーを通す(式を二重に書かない)。
  const matchDb = cal ? voiceMatchDb(cal.voiceRms, settings.normalizeRefDbfs) : null
  const diffDb =
    matchDb !== null && Number.isFinite(masterDb) ? currentTargetDb(masterDb, matchDb) : null
  // 声とぴったり一致させる送信音量。既に一致していればボタンを出さない。
  const restoreDb =
    cal && matchDb !== null && diffDb !== null && Math.abs(diffDb) >= 0.05
      ? recommendMasterDb(cal.voiceRms, settings.normalizeRefDbfs, 0).db
      : null

  return (
    <section className="shrink-0 border-t bg-toolbar p-2.5" aria-label="送信とモニターの設定">
      <Tabs defaultValue="tx">
        <TabsList className="grid h-9 w-full grid-cols-2 rounded-md bg-background/70 p-1">
          <TabsTrigger value="tx" className="gap-1.5 rounded-sm text-xs">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            送信
          </TabsTrigger>
          <TabsTrigger value="sidetone" className="gap-1.5 rounded-sm text-xs">
            <Headphones className="h-3.5 w-3.5" aria-hidden="true" />
            モニター
          </TabsTrigger>
        </TabsList>

        {/* この右レールは下半分が設定、上半分が再生中の一覧。設定が縦に伸びるほど
            一覧が潰れるので、送信タブは「今の差」と導線だけに絞り、詳しい数値と説明は
            title と音量調整ダイアログ側へ寄せる。 */}
        <TabsContent value="tx" className="space-y-2 pt-1">
          {/* 未校正のときはこの枠を出さない。基準になる声を測っていない段階の「送信ゲイン
              ±0.0 dB」は、相手にどう届くかを何も語らない数値で、しかも「調整済み」に
              見えてしまう。数値の代わりに下の導線だけを置く。 */}
          {cal && (
            <div
              className="rounded-md border bg-card px-3 py-2"
              title="効果音を自分の声より何 dB 大きく／小さく相手へ届けるか。上のフェーダーと同じ値です。"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium">声との差</span>
                <span
                  className={cn(
                    'font-mono text-sm tabular-nums',
                    diffDb !== null && Math.abs(diffDb) < 0.05
                      ? 'text-emerald-500'
                      : 'text-primary'
                  )}
                >
                  {fmtDb(diffDb ?? masterDb)}
                </span>
              </div>
            </div>
          )}

          {restoreDb !== null && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full"
              onClick={() => applyMasterDb(restoreDb, 0)}
            >
              声と同じ大きさに戻す
            </Button>
          )}

          {/* 未校正 = 相手にどの大きさで届くか一度も測っていない状態。この導線は既定タブに
              常時出ているので「見えない」問題は無いが、初めてのユーザーは自分のモニターで
              聞こえる音だけを頼りに「ちょうどいい」と判断してしまい、押す理由を持たない。
              状態を語れるのがこのボタンしかないので、未校正のときだけ塗り＋文言で示す
              (校正後は測り直しが常時必要な操作ではないので outline に落とす)。 */}
          <Button
            size="sm"
            variant={cal ? 'outline' : 'default'}
            className="h-8 w-full"
            onClick={() => setLevelOpen(true)}
            title={
              cal
                ? '声の測定をやり直したり、音源ごとの音量を揃え直したりできます。'
                : 'まだ声を測っていないため、効果音が相手にどの大きさで届くかは未調整です。モニターには自分の声が入らないので、声とのバランスは耳では確かめられません。'
            }
          >
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            {cal ? '音量を調整する' : 'まずは音量を調整'}
          </Button>
        </TabsContent>

        <TabsContent value="sidetone" className="space-y-2.5 pt-1">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">自分の端末でも聴く</div>
            </div>
            <Switch
              aria-label="自分の端末でも聴く"
              checked={settings.sidetoneEnabled}
              onCheckedChange={(checked) => patch({ sidetoneEnabled: checked })}
            />
          </div>
          <div>
            <ControlLabel>出力デバイス</ControlLabel>
            <Select
              value={settings.sidetoneDevice || 'default'}
              onValueChange={(value) => patch({ sidetoneDevice: value === 'default' ? '' : value })}
            >
              <SelectTrigger aria-label="モニター出力デバイス" className="h-9 bg-background/60">
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
          </div>
          <div title="自分の端末で鳴る音（モニター・試聴の両方）の音量です。相手に届く音量は変わりません。">
            <ControlLabel value={`${Math.round(settings.sidetoneVolume * 100)}%`}>モニター音量</ControlLabel>
            <Slider
              aria-label="モニター音量"
              value={[settings.sidetoneVolume * 100]}
              min={0}
              max={100}
              step={1}
              onValueChange={([value]) => patch({ sidetoneVolume: value! / 100 })}
            />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  )
}
