import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  FolderOpen,
  Headphones,
  Library,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import type { SoundItem } from '@shared/types'

function SoundTile({ sound }: { sound: SoundItem }): React.JSX.Element {
  const play = useStore((s) => s.play)
  const connection = useStore((s) => s.connection)
  const previewSrc = useStore((s) => s.previewSrc)
  const togglePreview = useStore((s) => s.togglePreview)
  const stopPreview = useStore((s) => s.stopPreview)
  const setSourceVolume = useStore((s) => s.setSourceVolume)
  const setSourceVolumeLive = useStore((s) => s.setSourceVolumeLive)
  const volume = useStore((s) => s.sourceVolumes[sound.id] ?? 1.0)
  // 校正済みの環境では送信音量が「全音源が基準へ揃っている」前提で決まるため、校正後に
  // 追加/リネームした音源だけが素の録音レベルのまま相手へ届く。値は 100% を指すだけなので、
  // 揃っていないことがタイルから分かるようにする(勝手に書き換えると「触っていないのに
  // 音が変わった」になるため、印を出すに留める)。
  const unadjusted = useStore((s) => s.settings.calibration !== null && !s.isVolumeAdjusted(sound.id))
  const stopVoice = useStore((s) => s.stopVoice)
  // この音が今 VC へ何本流れているか。配列ではなく件数を選ぶことで、無関係なタイルが
  // voices の更新のたびに再描画されるのを防ぐ(音源が数百件あると効いてくる)。
  const activeCount = useStore(
    (s) => s.voices.filter((v) => v.srcId === sound.id && v.kind === 'vc').length
  )
  const [open, setOpen] = useState(false)
  const isPreviewing = previewSrc === sound.id

  // このタイルから出ている送信をまとめて止める。個別の 1 本だけ止めたいときは右レール
  // (NowPlaying)を使う。voices は購読せず、押された時点の状態を読む。
  const stopThisSource = (): void => {
    for (const v of useStore.getState().voices) {
      if (v.srcId === sound.id && v.kind === 'vc') stopVoice(v.voiceId)
    }
  }
  // VC 未接続(通話中でない)時は左クリック再生を無効化。音量・試聴のポップオーバーは常に許可。
  const isConnected = connection === 'connected'

  return (
    <div
      className={cn(
        'group relative h-[92px] overflow-hidden rounded-md border bg-card transition-colors hover:border-primary/45 hover:bg-card-hover',
        // 送信中は枠で示す。右レールを見なくても、どのタイルが鳴っているかが分かる。
        activeCount > 0 && 'border-emerald-500/60'
      )}
      onContextMenu={(e) => {
        e.preventDefault()
        setOpen(true)
      }}
    >
      <button
        type="button"
        aria-label={sound.id}
        disabled={!isConnected}
        onClick={() => void play(sound.id)}
        title={
          isConnected ? undefined : 'VC未接続のため再生できません（右クリックで試聴・音量調節）'
        }
        className="flex h-full w-full min-w-0 flex-col items-start justify-between p-3 pr-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="grid h-7 w-7 place-items-center rounded-sm bg-primary/12 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
        </span>
        <span className="block w-full truncate text-sm font-semibold" title={sound.name}>
          {sound.id}
        </span>
      </button>

      {/* 閉じたら試聴も止める。鳴ったまま閉じると、止める手段が右レールしか無くなる
          (EntrySoundDialog も同じ理由で同じことをしている)。 */}
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v && isPreviewing) stopPreview()
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${sound.id}の音量設定`}
            title={`${sound.id}の音量設定`}
            className="absolute right-2 top-2 h-7 w-7 bg-background/65 text-muted-foreground hover:text-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-4">
          <div className="mb-4 min-w-0">
            <div className="truncate text-sm font-semibold" title={sound.name}>
              {sound.name}
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">この音の音量</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {Math.round(volume * 100)}%
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">送信・モニター共通</div>
            {unadjusted && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  この音はまだ音量を揃えていません。音量調整の「音源の音量を揃える」を実行するまで、
                  この音だけ相手への大きさがずれます。
                </span>
              </div>
            )}
          </div>
          <Slider
            aria-label={`${sound.id}の音量`}
            value={[volume * 100]}
            min={0}
            max={150}
            step={1}
            onValueChange={([value]) => setSourceVolumeLive(sound.id, value! / 100)}
            onValueCommit={([value]) => setSourceVolume(sound.id, value! / 100)}
          />
          <Button
            variant={isPreviewing ? 'secondary' : 'default'}
            size="sm"
            className="mt-4 w-full"
            onClick={() => togglePreview(sound.id)}
          >
            {isPreviewing ? (
              <>
                <Square className="h-3.5 w-3.5" />
                試聴を停止
              </>
            ) : (
              <>
                <Headphones className="h-3.5 w-3.5" />
                この端末で試聴
              </>
            )}
          </Button>
          {/* ポップオーバー(w-72)はタイル(150px前後)より広く、開くとタイル右下の停止ボタンを
              覆う。鳴らしながら音量を微調整するのは普通の操作なので、ここでも止められないと
              「閉じてから止める」か右レールへ回ることになり、タイルに停止を置いた意味が消える。 */}
          {activeCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full text-emerald-500 hover:text-emerald-400"
              onClick={stopThisSource}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              送信を停止{activeCount > 1 ? `（${activeCount} 本）` : ''}
            </Button>
          )}
        </PopoverContent>
      </Popover>

      {/* 音量バー。フルスケールは 150% だが、100%(既定)の位置に目盛りを打たないと
          既定値なのに「2/3 しか入っていない」ように見える。 */}
      <span
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 max-w-full bg-primary"
        style={{ width: `${Math.min(100, (volume / 1.5) * 100)}%` }}
        aria-hidden="true"
      />
      <span
        className="pointer-events-none absolute bottom-0 h-1 w-px bg-muted-foreground/50"
        style={{ left: `${(1 / 1.5) * 100}%` }}
        aria-hidden="true"
      />
      {/* 音量を揃えていない印。校正済みなのにこの音だけ基準から外れている状態を、
          タイルを見ただけで気付けるようにする(下端のバーは 100% を指すだけで、
          「揃えた結果の 100%」なのか「未調整の 100%」なのか区別が付かない)。 */}
      {unadjusted && !isPreviewing && (
        <span
          className="pointer-events-none absolute right-10 top-3.5 text-amber-500"
          title="この音はまだ音量を揃えていません"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">音量が未調整です</span>
        </span>
      )}
      {/* 試聴中の印。停止ボタンと場所を取り合わないよう、音量設定ボタンの左隣に置く。 */}
      {isPreviewing && (
        <span className="pointer-events-none absolute right-10 top-3.5 text-primary">
          <Headphones className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      {/* 停止は再生中のタイルにだけ出す。常設すると、通話中の早打ちで「鳴らすつもりが
          止める」を踏む。件数は同じ音を重ねたときだけ意味を持つので 2 本以上で出す。 */}
      {activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={stopThisSource}
          aria-label={`${sound.id}の送信を停止`}
          title={
            activeCount > 1
              ? `${sound.id}の送信 ${activeCount} 本をまとめて停止（1 本ずつ止めるには右の「再生中」から）`
              : `${sound.id}の送信を停止`
          }
          className="absolute bottom-1.5 right-1.5 h-7 w-7 bg-background/65 text-emerald-500 hover:text-emerald-400"
        >
          <Square className="h-3.5 w-3.5 fill-current" />
          {activeCount > 1 && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-[13px] text-background">
              {activeCount}
            </span>
          )}
        </Button>
      )}
    </div>
  )
}

export function SoundGrid(): React.JSX.Element {
  const sounds = useStore((s) => s.sounds)
  const folder = useStore((s) => s.folder)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const reload = useStore((s) => s.reload)
  const filtered = useMemo(
    () => sounds.filter((sound) => sound.id.toLowerCase().includes(search.toLowerCase())),
    [sounds, search]
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="library-title">
      <div className="shrink-0 border-b px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Library className="h-4 w-4 text-primary" aria-hidden="true" />
            <h1 id="library-title" className="text-sm font-semibold">
              サウンドライブラリ
            </h1>
            <span className="font-mono text-[11px] text-muted-foreground">
              {filtered.length}/{sounds.length}
            </span>
          </div>
          {/* 今どのフォルダを見ているか。store は持っているのに画面に出ていなかったので、
              「並んでいるのがどこのファイルか」を確かめる手段が無かった。 */}
          <span
            className="ml-3 min-w-0 truncate font-mono text-[11px] text-muted-foreground"
            title={folder || 'フォルダが選ばれていません'}
          >
            {folder || 'フォルダ未選択'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="サウンドを検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="サウンドを検索"
              className="h-9 bg-card pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            aria-label="サウンドフォルダを選択"
            title="サウンドフォルダを選択"
            onClick={() => void chooseFolder()}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            aria-label="サウンド一覧を再読込"
            title="サウンド一覧を再読込"
            onClick={() => void reload()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* 「検索で 0 件」と「フォルダに音源が無い」は原因も次の行動も違うので分ける。
            配布した exe はサウンドを同梱しないため、初回起動は必ず後者を通る。
            フォルダを選ぶボタンはヘッダー右上にもあるが、初回の導線としては小さすぎるので
            空状態の中にも置く。 */}
        {sounds.length === 0 ? (
          <div className="grid h-full min-h-56 place-items-center p-8 text-center">
            <div className="max-w-sm">
              <FolderOpen className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">このフォルダにサウンドがありません</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {folder || '（フォルダが選ばれていません）'}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                wav / mp3 / ogg などの音声ファイルをこのフォルダに置くか、別のフォルダを選んでください。
              </p>
              <Button className="mt-4" size="sm" onClick={() => void chooseFolder()}>
                <FolderOpen className="h-3.5 w-3.5" />
                サウンドフォルダを選ぶ
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid h-full min-h-56 place-items-center p-8 text-center">
            <div>
              <Search className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">「{search}」に一致するサウンドがありません</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setSearch('')}
              >
                検索を消す
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 p-4">
            {filtered.map((sound) => (
              <SoundTile key={sound.id} sound={sound} />
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}
