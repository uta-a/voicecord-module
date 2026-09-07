import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, DoorOpen, Headphones, Search, Square } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

function FieldLabel({
  children,
  value
}: {
  children: React.ReactNode
  value?: string
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between text-xs font-medium">
      <span>{children}</span>
      {value && <span className="font-mono text-[11px] text-muted-foreground">{value}</span>}
    </div>
  )
}

export function EntrySoundDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  const sounds = useStore((s) => s.sounds)
  const previewSrc = useStore((s) => s.previewSrc)
  const togglePreview = useStore((s) => s.togglePreview)
  const stopPreview = useStore((s) => s.stopPreview)
  const testEntrySound = useStore((s) => s.testEntrySound)
  const [query, setQuery] = useState('')

  // 閉じたら試聴を止める。画面を閉じた後も鳴り続けると、止める手段が分かりにくい。
  const handleOpenChange = (next: boolean): void => {
    if (!next) stopPreview()
    onOpenChange(next)
  }

  // ここでの試聴は入場音の音量で鳴らすため、0% だと何も聞こえない。
  // 黙って無音だと「試聴が壊れた」と受け取られるので、鳴らす前に断っておく。
  const warnIfMuted = (): void => {
    if (settings.entrySoundVolume === 0) {
      toast('入場音の音量が 0% です。音が出ていないかもしれません', { duration: 3000 })
    }
  }

  const filtered = useMemo(
    () => sounds.filter((sound) => sound.id.toLowerCase().includes(query.toLowerCase())),
    [sounds, query]
  )
  const selected = settings.entrySoundSrcId
  const selectedMissing = selected !== '' && !sounds.some((s) => s.id === selected)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DoorOpen className="h-4 w-4 text-primary" aria-hidden="true" />
            入場サウンド
          </DialogTitle>
          <DialogDescription>
            VC に入ったのを検知して、選んだ音を 1 回だけ自動で送信します。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">入場時に自動で鳴らす</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {selected === ''
                ? 'サウンドが未選択のため鳴りません'
                : selectedMissing
                  ? `「${selected}」が見つかりません（ファイルが移動・削除された可能性）`
                  : `現在の音源: ${selected}`}
            </div>
          </div>
          <Switch
            aria-label="入場サウンドを有効にする"
            checked={settings.entrySoundEnabled}
            onCheckedChange={(checked) => patch({ entrySoundEnabled: checked })}
          />
        </div>

        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_240px] gap-5">
          <div className="flex min-h-0 flex-col">
            <FieldLabel value={`${filtered.length}/${sounds.length}`}>音源を選ぶ</FieldLabel>
            <div className="relative mb-2">
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="入場サウンドを検索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="サウンドを検索"
                className="h-9 bg-card pl-9"
              />
            </div>
            {/* 低いウィンドウではリスト自体も縮める(モーダル全体がスクロールに落ちるのを避ける) */}
            {/* Radix の Viewport 直下は display:table で内容幅まで横に広がるため、block に
                戻さないと子の truncate が効かず、長い名前が枠外へ溢れて試聴ボタンを押し出す。 */}
            <ScrollArea className="h-[min(260px,40vh)] rounded-md border bg-card/40 [&>[data-radix-scroll-area-viewport]>div]:!block">
              {filtered.length === 0 ? (
                <div className="grid h-[min(260px,40vh)] place-items-center px-6 text-center">
                  <p className="text-xs text-muted-foreground">
                    該当するサウンドがありません
                  </p>
                </div>
              ) : (
                <ul className="p-1.5">
                  {filtered.map((sound) => {
                    const isSelected = selected === sound.id
                    const isPreviewing = previewSrc === sound.id
                    return (
                      <li key={sound.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => patch({ entrySoundSrcId: sound.id })}
                          title={sound.name}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                            isSelected && 'bg-primary/12 text-primary'
                          )}
                        >
                          <Check
                            className={cn('h-3.5 w-3.5 shrink-0', !isSelected && 'opacity-0')}
                            aria-hidden="true"
                          />
                          {/* min-w-0 が無いと flex アイテムの既定 min-width:auto で truncate が
                              効かず、長い名前が枠外へ溢れて試聴ボタンを押し出す。 */}
                          <span className="min-w-0 truncate">{sound.id}</span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${sound.id}を試聴`}
                          title={`${sound.id}を試聴`}
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            if (!isPreviewing) warnIfMuted() // 停止操作では出さない
                            togglePreview(sound.id, settings.entrySoundVolume)
                          }}
                        >
                          {isPreviewing ? (
                            <Square className="h-3.5 w-3.5" />
                          ) : (
                            <Headphones className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>

          <div className="space-y-4">
            <div>
              <FieldLabel value={`${Math.round(settings.entrySoundVolume * 100)}%`}>
                入場音の音量
              </FieldLabel>
              <Slider
                aria-label="入場音の音量"
                value={[settings.entrySoundVolume * 100]}
                min={0}
                max={150}
                step={1}
                onValueChange={([value]) => patch({ entrySoundVolume: value! / 100 })}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                音源ごとの音量とは別に持ちます。入場音は自分の声に重ねて 1 回だけ鳴ります。
              </p>
            </div>

            <div>
              <FieldLabel value={`${(settings.entryDelayMs / 1000).toFixed(1)}秒`}>
                鳴るまでの追加の間
              </FieldLabel>
              <Slider
                aria-label="鳴るまでの追加の間"
                value={[settings.entryDelayMs]}
                min={0}
                max={3000}
                step={100}
                onValueChange={([value]) => patch({ entryDelayMs: value })}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                0 でも送信の準備待ちで最大 1.5 秒ほどかかります。ここはその上に足す間です。
              </p>
            </div>

            <div>
              <FieldLabel value={`${(settings.entryLeaveDebounceMs / 1000).toFixed(1)}秒`}>
                退出とみなす時間
              </FieldLabel>
              <Slider
                aria-label="退出とみなす時間"
                value={[settings.entryLeaveDebounceMs]}
                min={1000}
                max={5000}
                step={100}
                onValueChange={([value]) => patch({ entryLeaveDebounceMs: value })}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                短くするとチャンネル移動でも鳴りやすくなりますが、通信の一瞬の途切れでも
                誤って鳴ることがあります。
              </p>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={selected === '' || selectedMissing}
              onClick={() => {
                if (previewSrc !== selected) warnIfMuted() // 停止操作では出さない
                testEntrySound()
              }}
            >
              {previewSrc === selected && selected !== '' ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  テストを停止
                </>
              ) : (
                <>
                  <Headphones className="h-3.5 w-3.5" />
                  この端末でテスト再生
                </>
              )}
            </Button>
            {/* テストは Web Audio のローカル再生(store の togglePreview)で、gain は
                モニター音量 × 音源音量 × 送信音量。送信音量まで掛かるので「送信音量が試聴に
                効かない」と読める書き方はしない。相手側と絶対値が違うのは送信ヘッドルーム
                (TX_GAIN ≒ -12dB)のぶんだけで、あとはゲート待ちの有無。 */}
            <p className="mt-2 text-[11px] text-muted-foreground">
              テストはこの端末だけで鳴ります。送信音量とモニター音量はテストにも掛かりますが、
              実際の入場時はさらに送信ヘッドルーム(約 -12 dB)が掛かり、送信の準備が整うまでの
              待ちも入るため、絶対的な音量とタイミングはここでの確認と異なります。
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
