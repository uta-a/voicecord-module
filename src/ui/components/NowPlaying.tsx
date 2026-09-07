import { AudioLines, Headphones, Radio, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStore, type Voice } from '@/store'

function VoiceRow({ voice, dupIndex }: { voice: Voice; dupIndex: number }): React.JSX.Element {
  const setVoiceVolume = useStore((s) => s.setVoiceVolume)
  const setSourceVolume = useStore((s) => s.setSourceVolume)
  const setSourceVolumeLive = useStore((s) => s.setSourceVolumeLive)
  const stopVoice = useStore((s) => s.stopVoice)
  const togglePreview = useStore((s) => s.togglePreview)
  const isPreview = voice.kind === 'preview'

  // 同じ見た目のスライダーだが保存先が違う。試聴行はこの音の既定音量そのものを書き換えて
  // 永続化し、VC 行はこの再生にだけ効いて保存されない。区別が消えると「試聴で微調整した
  // つもりが以後の送信音量まで変わっていた」が起きる。
  // 「どこへ鳴っているか」と「音量がどこへ保存されるか」は 1:1 に対応するので、行を詰める
  // ために 1 つのラベルに統合する(明示が要るのは保存される試聴側)。
  const kindLabel = isPreview ? '試聴・既定を編集' : 'VCへ送信中'
  const scopeLabel = isPreview ? '既定として保存' : 'この再生のみ'

  return (
    <div className="relative overflow-hidden rounded-md border bg-card px-3 py-2">
      <span
        className={`absolute inset-y-0 left-0 w-0.5 ${isPreview ? 'bg-primary' : 'bg-emerald-500'}`}
        aria-hidden="true"
      />
      <div className="flex min-w-0 items-center gap-2">
        {isPreview ? (
          <Headphones className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <Radio className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={voice.name}>
          {voice.name}
        </span>
        {/* 同じ音を重ねたときだけ通し番号を出す。名前しか出ていないと、8 本まで積める
            この一覧で「さっき鳴らした方だけ止めたい」が行の勘に頼ることになる。 */}
        {dupIndex > 0 && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground"
            title="同じ音の中での現在の順番です。1 本止めると番号は振り直されます"
          >
            #{dupIndex}
          </span>
        )}
        <span
          className={`shrink-0 text-[10px] ${isPreview ? 'text-primary' : 'text-emerald-500'}`}
          title={`音量は${scopeLabel}`}
        >
          {kindLabel}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => (isPreview ? togglePreview(voice.srcId) : stopVoice(voice.voiceId))}
          aria-label={`${voice.name}を停止`}
          title={`${voice.name}を停止`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Slider
          aria-label={`${voice.name}の音量（${scopeLabel}）`}
          value={[voice.volume * 100]}
          min={0}
          max={150}
          step={1}
          // 試聴行はこの音の既定音量そのものを書き換えるので、保存は指を離したときだけにする。
          // VC 行は元から保存しない(この再生にだけ効く)ので、分ける必要がない。
          onValueChange={([value]) => {
            if (isPreview) setSourceVolumeLive(voice.srcId, value! / 100)
            else setVoiceVolume(voice.voiceId, value! / 100)
          }}
          onValueCommit={([value]) => {
            if (isPreview) setSourceVolume(voice.srcId, value! / 100)
          }}
        />
        <span
          className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
          title={`音量（${scopeLabel}）`}
        >
          {Math.round(voice.volume * 100)}%
        </span>
      </div>
    </div>
  )
}

// 同じ音源が複数鳴っているときの通し番号(1 始まり)。1 本しか無ければ 0 を返し、
// 呼び出し側は番号を出さない。表示専用で、store にも hook.js にも持たせない。
function dupIndexOf(voices: Voice[], voice: Voice): number {
  let n = 0
  let seen = 0
  for (const v of voices) {
    if (v.srcId !== voice.srcId || v.kind !== voice.kind) continue
    n++
    if (v.voiceId === voice.voiceId) seen = n
  }
  return n > 1 ? seen : 0
}

export function NowPlaying(): React.JSX.Element {
  const voices = useStore((s) => s.voices)

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="queue-title">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <AudioLines className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 id="queue-title" className="text-sm font-semibold">
            再生中
          </h2>
        </div>
        <Badge variant={voices.length > 0 ? 'default' : 'secondary'} className="font-mono">
          {voices.length}
        </Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {voices.length === 0 ? (
          <div className="grid h-full min-h-36 place-items-center px-6 text-center">
            <div>
              <AudioLines className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">再生中のサウンドはありません</p>
              <p className="mt-1 text-xs text-muted-foreground">サウンドを選ぶとここに表示されます</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {voices.map((voice) => (
              <VoiceRow key={voice.voiceId} voice={voice} dupIndex={dupIndexOf(voices, voice)} />
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}
