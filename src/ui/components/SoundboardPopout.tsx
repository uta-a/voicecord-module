import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  DoorOpen,
  Folder,
  FolderOpen,
  Headphones,
  Library,
  Mic,
  Play,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Square
} from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { NowPlaying } from '@/components/NowPlaying'
import { SettingsTabs } from '@/components/SettingsTabs'
import { EntrySoundDialog } from '@/components/EntrySoundDialog'
import { MasterFader } from '@/components/MasterFader'
import { guardTrusted } from '@/lib/trusted'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { usePopout } from '@/popout'
import { DOT_LABEL, statusProblems } from '@shared/status'
import { ROOT_ID } from '../../preload/shell.js'
import type { ConnState, SoundItem } from '@shared/types'

/**
 * Discord のサウンドボードと同じ意匠のポップアウト。
 *
 * 寸法は 2026-09-14 に Canary 1.0.1169 の純正ポップアウトを CDP で実測した値に合わせてある:
 * 幅 531px、ヘッダ 64px（検索 40px + 右に歯車 24px）、左に 48px のカテゴリ列、
 * セクション見出し 32px（14px / 600）、タイル 148x40 角丸 8px、行の間隔 8px。
 * 純正の DOM は採取しない（自前で再現する、という決定）。
 *
 * 純正に無い機能（全体音量、再生中の一覧、送信状態、入場サウンド、校正）は、
 * ポップアウトを縦に伸ばして下端と設定画面（歯車）に入れる。
 */

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
      className: 'border-warning/60 bg-warning/15 text-warning',
      title:
        'エンジンとの接続が切れたため、マイクが常時送信のままかどうかを確認できません。再接続すると自動で元に戻ります。'
    }
  }

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter((s) => s !== '').pop() ?? 'サウンドフォルダ'
}

function IconButton({
  label,
  onClick,
  children,
  className
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      {children}
    </button>
  )
}

function VolumePopoverBody({ sound }: { sound: SoundItem }): React.JSX.Element {
  const previewSrc = useStore((s) => s.previewSrc)
  const togglePreview = useStore((s) => s.togglePreview)
  const setSourceVolume = useStore((s) => s.setSourceVolume)
  const setSourceVolumeLive = useStore((s) => s.setSourceVolumeLive)
  const volume = useStore((s) => s.sourceVolumes[sound.id] ?? 1.0)
  const unadjusted = useStore((s) => s.settings.calibration !== null && !s.isVolumeAdjusted(sound.id))
  const isPreviewing = previewSrc === sound.id

  return (
    <>
      <div className="mb-4 min-w-0">
        <div className="truncate text-sm font-semibold" title={sound.name}>
          {sound.name}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">この音の音量（送信・モニター共通）</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {Math.round(volume * 100)}%
          </span>
        </div>
        {unadjusted && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
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
    </>
  )
}

function SoundTile({ sound }: { sound: SoundItem }): React.JSX.Element {
  const play = useStore((s) => s.play)
  const connection = useStore((s) => s.connection)
  const previewSrc = useStore((s) => s.previewSrc)
  const togglePreview = useStore((s) => s.togglePreview)
  const stopPreview = useStore((s) => s.stopPreview)
  const stopVoice = useStore((s) => s.stopVoice)
  const unadjusted = useStore((s) => s.settings.calibration !== null && !s.isVolumeAdjusted(sound.id))
  // 件数を選ぶ(配列を選ぶと無関係なタイルまで voices の更新で再描画される)
  const activeCount = useStore(
    (s) => s.voices.filter((v) => v.srcId === sound.id && v.kind === 'vc').length
  )
  const [open, setOpen] = useState(false)
  const isPreviewing = previewSrc === sound.id
  const isConnected = connection === 'connected'

  const stopThisSource = (): void => {
    for (const v of useStore.getState().voices) {
      if (v.srcId === sound.id && v.kind === 'vc') stopVoice(v.voiceId)
    }
  }

  return (
    <li
      className="vc-tile h-10 w-[148px] rounded-lg"
      onContextMenu={(e) => {
        e.preventDefault()
        setOpen(true)
      }}
    >
      <div
        className="vc-tile-face group relative flex h-full w-full items-center overflow-hidden rounded-lg"
        data-active={activeCount > 0}
      >
        <button
          type="button"
          aria-label={`${sound.id}をプレイする`}
          disabled={!isConnected}
          // VC へ音を流す操作なので、ページ側のスクリプトの合成クリックでは鳴らさない
          onClick={guardTrusted('タイルの再生', () => void play(sound.id))}
          title={isConnected ? sound.name : 'VC未接続のため再生できません（右クリックで試聴・音量調節）'}
          className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed"
        />
        <span
          className={cn(
            'pointer-events-none flex min-w-0 flex-1 items-center justify-center gap-1.5 p-2',
            !isConnected && 'opacity-50'
          )}
        >
          {unadjusted && (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="音量が未調整です" />
          )}
          {isPreviewing && <Headphones className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{sound.id}</span>
        </span>

        {/* ホバー時の操作。純正は「プレビュー」と「お気に入り」を左右に置き、中央に再生の印を出す。
            ここは「試聴」と「音量」を置き、鳴っているときは中央を「停止」にする。 */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <span className="absolute inset-0 bg-background/75" aria-hidden="true" />
          <IconButton
            label={isPreviewing ? `${sound.id}の試聴を停止` : `${sound.id}を試聴`}
            onClick={() => togglePreview(sound.id)}
            className="pointer-events-auto relative h-7 w-7"
          >
            {isPreviewing ? <Square className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
          </IconButton>
          {activeCount > 0 ? (
            <IconButton
              label={
                activeCount > 1 ? `${sound.id}の送信 ${activeCount} 本をまとめて停止` : `${sound.id}の送信を停止`
              }
              onClick={stopThisSource}
              className="pointer-events-auto relative h-7 w-7 text-success hover:text-success"
            >
              <Square className="h-4 w-4 fill-current" />
            </IconButton>
          ) : (
            <Play className="relative h-4 w-4 fill-current text-foreground" aria-hidden="true" />
          )}
          <Popover
            open={open}
            onOpenChange={(v) => {
              setOpen(v)
              if (!v && isPreviewing) stopPreview()
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${sound.id}の音量設定`}
                title={`${sound.id}の音量設定`}
                className="pointer-events-auto relative grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 bg-popover p-4">
              <VolumePopoverBody sound={sound} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </li>
  )
}

function MicBadge(): React.JSX.Element | null {
  const micTransmit = useStore((s) => s.micTransmit)
  if (micTransmit === 'closed') return null
  const mic = MIC_TRANSMIT[micTransmit]
  return (
    <span
      className={cn('flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium', mic.className)}
      title={mic.title}
      aria-live="polite"
    >
      <Mic className="h-3 w-3" aria-hidden="true" />
      {mic.label}
    </span>
  )
}

/** mod 自身の不調。平常時は出さない（純正のポップアウトに無い帯を常設しない） */
function StatusNotice(): React.JSX.Element | null {
  const status = usePopout((s) => s.status)
  const setView = usePopout((s) => s.setView)
  if (status === null) return null
  const problems = statusProblems(status)
  if (status.engine === 'attached' && problems.length === 0) return null
  const text = problems[0] ?? DOT_LABEL[status.engine]
  return (
    <button
      type="button"
      onClick={() => setView('settings')}
      className="flex shrink-0 items-center gap-2 border-b bg-warning/15 px-3 py-2 text-left text-xs text-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">VoiceCord: {text}</span>
      <span className="shrink-0 underline">詳細</span>
    </button>
  )
}

function MainView(): React.JSX.Element {
  const sounds = useStore((s) => s.sounds)
  const folder = useStore((s) => s.folder)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const reload = useStore((s) => s.reload)
  const voices = useStore((s) => s.voices)
  const stopAll = useStore((s) => s.stopAll)
  const setView = usePopout((s) => s.setView)
  const filtered = useMemo(
    () => sounds.filter((sound) => sound.id.toLowerCase().includes(search.toLowerCase())),
    [sounds, search]
  )

  return (
    <>
      <header className="vc-popout-header relative z-10 flex h-16 shrink-0 items-center gap-3 p-3">
        <label className="vc-search flex h-10 min-w-0 flex-1 items-center gap-1 rounded-lg pl-1">
          <span className="grid h-[30px] w-[30px] shrink-0 place-items-center text-foreground" aria-hidden="true">
            <Search className="h-4 w-4" />
          </span>
          <input
            aria-label="サウンドを検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="サウンドを検索"
            className="h-full min-w-0 flex-1 bg-transparent pr-3 text-base text-foreground outline-none"
          />
        </label>
        <IconButton label="VoiceCord の設定" onClick={() => setView('settings')} className="h-6 w-6">
          <Settings className="h-6 w-6" />
        </IconButton>
      </header>
      <StatusNotice />

      <div className="flex h-[456px] min-h-0 shrink">
        <nav aria-label="カテゴリ" className="w-12 shrink-0 bg-card p-2">
          <div
            className="grid h-8 w-8 place-items-center rounded-sm bg-background p-1 text-muted-foreground"
            title={folder || 'サウンドフォルダ'}
            aria-current="true"
          >
            <Library className="h-6 w-6" aria-hidden="true" />
          </div>
        </nav>

        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="flex h-8 items-center gap-1 bg-background pl-2 pr-1 text-muted-foreground">
            <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
            <h2 className="min-w-0 truncate text-sm font-semibold" title={folder || 'フォルダ未選択'}>
              {folder ? folderName(folder) : 'フォルダ未選択'}
            </h2>
            <span className="ml-1 shrink-0 font-mono text-[11px]">
              {filtered.length}/{sounds.length}
            </span>
            <span className="flex-1" />
            <IconButton label="サウンドフォルダを選択" onClick={() => void chooseFolder()} className="h-6 w-6">
              <FolderOpen className="h-4 w-4" />
            </IconButton>
            <IconButton label="サウンド一覧を再読込" onClick={() => void reload()} className="h-6 w-6">
              <RefreshCw className="h-4 w-4" />
            </IconButton>
          </div>

          {/* 「検索で 0 件」と「フォルダに音源が無い」は原因も次の行動も違うので分ける */}
          {sounds.length === 0 ? (
            <div className="grid min-h-56 place-items-center p-6 text-center">
              <div className="max-w-sm">
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
            <div className="grid min-h-56 place-items-center p-6 text-center">
              <div>
                <p className="text-sm font-medium">「{search}」に一致するサウンドがありません</p>
                <Button variant="secondary" size="sm" className="mt-4" onClick={() => setSearch('')}>
                  検索を消す
                </Button>
              </div>
            </div>
          ) : (
            <ul className="flex flex-wrap gap-2 pb-2 pl-2 pr-2" aria-label="サウンド">
              {filtered.map((sound) => (
                <SoundTile key={sound.id} sound={sound} />
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>

      <div className="shrink-0 border-t bg-background">
        {voices.length > 0 && (
          <div className="flex h-40 flex-col border-b">
            <NowPlaying />
          </div>
        )}
        <div className="flex items-center gap-3 px-3 py-2">
          <MasterFader className="flex-1" />
          <MicBadge />
          <Button variant="destructive" size="sm" onClick={stopAll} className="h-8 shrink-0">
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            全停止
          </Button>
        </div>
      </div>
    </>
  )
}

function StatusSection(): React.JSX.Element {
  const status = usePopout((s) => s.status)
  const info = usePopout((s) => s.anchorInfo)
  const connection = useStore((s) => s.connection)
  const detail = useStore((s) => s.connectionDetail)
  const state = CONNECTION[connection]
  const problems = status ? statusProblems(status) : []

  const rows: Array<[string, string]> = []
  if (status) {
    rows.push(['エンジン', DOT_LABEL[status.engine]])
    rows.push(['ビルド', `${status.discordBuild} ${status.discordVersion}`])
    rows.push(['注入先', status.attachedPid === null ? '未検出' : `PID ${status.attachedPid}`])
    rows.push(['エンジン PID', status.enginePid === null ? '起動していません' : String(status.enginePid)])
    rows.push([
      '注入レート',
      status.sampleRate === null ? '未計測' : `${status.sampleRate} Hz（${status.frameSamples ?? '?'} サンプル）`
    ])
  }
  if (info) {
    rows.push([
      'ボタン',
      info.mode === 'graft'
        ? `サウンドボードの隣（${info.tier ?? '?'} 段目で発見）`
        : info.mode === 'fab'
          ? '画面の端（予備）'
          : '未表示'
    ])
    rows.push(['採取', info.harvest])
    rows.push(['再挿入', `${info.inserts} 回${info.tripped ? '（上限を超えたので停止）' : ''}`])
  }

  return (
    <section aria-label="状態" className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant={state.variant} className="h-5 shrink-0 px-2 py-0">
          {state.label}
        </Badge>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={detail}>
          {detail}
        </span>
      </div>
      {info?.fabReason && <p className="text-xs text-warning">{info.fabReason}</p>}
      {info && info.tier !== null && info.tier > 1 && (
        <p className="text-xs text-warning">
          サウンドボードのボタンを予備の方法で見つけています。Discord の次の更新でボタンが出なくなる可能性があります。
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
      {problems.length > 0 && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          {problems.join('\n')}
        </div>
      )}
    </section>
  )
}

function SettingsView(): React.JSX.Element {
  const setView = usePopout((s) => s.setView)
  const folder = useStore((s) => s.folder)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const reload = useStore((s) => s.reload)
  const entryEnabled = useStore((s) => s.settings.entrySoundEnabled)
  const entrySrcId = useStore((s) => s.settings.entrySoundSrcId)
  const [entryOpen, setEntryOpen] = useState(false)
  // 有効でも音源が未選択なら鳴らない。OFF と同じ表示にすると混乱するので独立した状態にする
  const entryLabel = !entryEnabled ? 'OFF' : entrySrcId === '' ? '未設定' : entrySrcId

  return (
    <>
      <header className="vc-popout-header relative z-10 flex h-16 shrink-0 items-center gap-2 p-3">
        <IconButton label="サウンドボードに戻る" onClick={() => setView('main')} className="h-8 w-8">
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <h2 className="text-base font-semibold">VoiceCord の設定</h2>
      </header>
      <div className="flex h-[456px] min-h-0 shrink flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4">
            <StatusSection />
            <section className="space-y-2" aria-label="入場サウンド">
              <h3 className="text-xs font-semibold text-muted-foreground">入場サウンド</h3>
              <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => setEntryOpen(true)}>
                <DoorOpen className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="min-w-0 truncate">入場サウンド: {entryLabel}</span>
              </Button>
            </section>
            <section className="space-y-2" aria-label="サウンドフォルダ">
              <h3 className="text-xs font-semibold text-muted-foreground">サウンドフォルダ</h3>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{folder || 'フォルダ未選択'}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => void chooseFolder()}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  フォルダを選ぶ
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void reload()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  再読込
                </Button>
              </div>
            </section>
          </div>
        </ScrollArea>
        <SettingsTabs />
      </div>
      <EntrySoundDialog open={entryOpen} onOpenChange={setEntryOpen} />
    </>
  )
}

export function SoundboardPopout(): React.JSX.Element {
  const open = usePopout((s) => s.open)
  const anchor = usePopout((s) => s.anchor)
  const view = usePopout((s) => s.view)
  const setOpen = usePopout((s) => s.setOpen)
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor])

  return (
    <Popover open={open && anchor !== null} onOpenChange={setOpen}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-label="VoiceCord サウンドボード"
        // 外側の操作で閉じない場合が 2 つある（onInteractOutside は外側のクリックと
        // フォーカス移動の両方で呼ばれる）。
        //   - アンカーのボタン: 「外側クリックで閉じる → click で開き直す」を起こさない。
        //     開閉はボタンの click（preload 側）が持つ
        //   - #vc-root の中: ポップアウトから開いた LevelDialog や入場サウンドのダイアログは
        //     ポップアウトの React ツリーの外にあるので、Radix には「外側」に見える。
        //     閉じてしまうと、ダイアログを閉じたときに戻る場所が無くなる
        onInteractOutside={(e) => {
          const t = e.target
          if (!(t instanceof Node)) return
          if (anchor?.contains(t)) {
            e.preventDefault()
            return
          }
          const el = t instanceof Element ? t : t.parentElement
          if (el?.closest(`#${ROOT_ID}`)) e.preventDefault()
        }}
        // bg-background / border-0 は PopoverContent 既定の bg-popover / border を tailwind-merge で
        // 外すため。残すと Tailwind の #vc-root .bg-popover が .vc-popout の塗りに勝ち、
        // 純正より 1 段明るい --background-surface-higher になる（実機で比較して判明）
        className="vc-popout flex w-[531px] max-w-[calc(100vw-16px)] flex-col border-0 bg-background p-0"
        style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
      >
        {view === 'main' ? <MainView /> : <SettingsView />}
      </PopoverContent>
    </Popover>
  )
}
