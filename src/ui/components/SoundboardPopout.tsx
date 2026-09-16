import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  ChevronDown,
  Folder,
  FolderOpen,
  Headphones,
  Library,
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
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MonitorSection, VolumeSection } from '@/components/SettingsSections'
import { SettingsRow } from '@/components/SettingsRow'
import { EntrySoundDialog } from '@/components/EntrySoundDialog'
import { MasterFader } from '@/components/MasterFader'
import { guardTrusted } from '@/lib/trusted'
import { cn } from '@/lib/utils'
import { engineApi, useStore } from '@/store'
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
 * 純正に無い機能（全体音量、送信状態、入場サウンド、校正）は、
 * 下端と設定画面（歯車）に入れる。
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
  const unadjusted = useStore((s) => s.settings.calibration !== null && !s.isVolumeAdjusted(sound.id))
  const [open, setOpen] = useState(false)
  const isPreviewing = previewSrc === sound.id
  const isConnected = connection === 'connected'

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
      >
        <button
          type="button"
          aria-label={`${sound.id}をプレイする`}
          disabled={!isConnected}
          // VC へ音を流す操作なので、ページ側のスクリプトの合成クリックでは鳴らさない
          onClick={guardTrusted('タイルの再生', (e: React.MouseEvent<HTMLButtonElement>) => {
            // クリック後に残る :focus-within で、マウスを離しても操作オーバーレイが残らないようにする。
            e.currentTarget.blur()
            void play(sound.id)
          })}
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

        {/* 純正と同じく中央は常に再生の印。試聴と音量は左右の操作に分ける。 */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <span className="absolute inset-0 bg-background/75" aria-hidden="true" />
          <IconButton
            label={isPreviewing ? `${sound.id}の試聴を停止` : `${sound.id}を試聴`}
            onClick={() => togglePreview(sound.id)}
            className="pointer-events-auto relative h-7 w-7"
          >
            {isPreviewing ? <Square className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
          </IconButton>
          <Play className="relative h-4 w-4 fill-current text-foreground" aria-hidden="true" />
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

// 全音源を保存済みの基準へ揃える(手で決めた音量も上書きする)。VC へ音を流さない操作なので guardTrusted は付けない。
// 「全停止」の隣に置くので、押し間違えても害の無い見た目(赤くない)にする。
function NormalizeButton(): React.JSX.Element {
  const count = useStore((s) => s.sounds.length)
  const job = useStore((s) => s.normalizeJob)
  const normalizeAll = useStore((s) => s.normalizeAll)
  const label = job
    ? `音量を揃えています（${job.done}/${job.total}）`
    : !engineApi
      ? 'エンジンに接続されていないため、音量を揃えられません'
      : count === 0
        ? '音源がありません'
        : 'すべての音源の音量を揃える'
  return (
    // disabled な button には Chromium がマウスイベントを配送せず title が出ないので、
    // 押せない理由は外側にも title で持たせる。
    <span title={label} className="shrink-0">
      <Button
        variant="secondary"
        size="sm"
        aria-label={label}
        title={label}
        disabled={job !== null || !engineApi || count === 0}
        onClick={() => void normalizeAll()}
        className="h-8"
      >
        <AudioLines className="h-3.5 w-3.5" aria-hidden="true" />
        {job ? (
          <span className="font-mono tabular-nums">
            {job.done}/{job.total}
          </span>
        ) : (
          '揃える'
        )}
      </Button>
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
        <div className="flex items-center gap-3 px-3 py-2">
          <MasterFader className="flex-1" />
          <NormalizeButton />
          {/* 「揃える」と押し間違えないよう、gap-3 より少し離す */}
          <Button variant="destructive" size="sm" onClick={stopAll} className="ml-1 h-8 shrink-0">
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
  const tierWarning = info !== null && info.tier !== null && info.tier > 2
  // 普段は見ない診断の値なので畳んでおくが、不具合があるときは開いておく(畳んだ中に隠さない)。
  // 開いた後に不具合が出た・変わった場合も同じ理由で開く。有無ではなく内容で見るのは、
  // 畳んだ後に別の不具合が増えても気付けるようにするため。内容が同じなら畳んだままにする。
  const hasIssue = problems.length > 0 || Boolean(info?.fabReason) || tierWarning
  const issueKey = hasIssue ? JSON.stringify([problems, info?.fabReason ?? null, tierWarning]) : ''
  const [expanded, setExpanded] = useState(hasIssue)
  useEffect(() => {
    if (issueKey !== '') setExpanded(true)
  }, [issueKey])

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
    <section aria-label="接続状態">
      <h3 className="text-xs font-semibold text-muted-foreground">接続状態</h3>
      <div className="flex items-center justify-between gap-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={state.variant} className="h-5 shrink-0 px-2 py-0">
            {state.label}
          </Badge>
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={detail}>
            {detail}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-expanded={expanded}
          aria-controls="vc-status-detail"
          onClick={() => setExpanded((v) => !v)}
        >
          詳細
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
      </div>
      {/* aria-controls の指す先が畳んだときも存在するよう、描画したまま hidden で隠す */}
      <div id="vc-status-detail" hidden={!expanded} className="space-y-2">
        {info?.fabReason && <p className="text-xs text-warning">{info.fabReason}</p>}
        {tierWarning && (
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
      </div>
    </section>
  )
}

function SettingsView(): React.JSX.Element {
  const setView = usePopout((s) => s.setView)
  const folder = useStore((s) => s.folder)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const reload = useStore((s) => s.reload)
  const sounds = useStore((s) => s.sounds)
  const entryEnabled = useStore((s) => s.settings.entrySoundEnabled)
  const hideCamera = useStore((s) => s.settings.hideCameraButton)
  const unlockSoundboard = useStore((s) => s.settings.unlockSoundboard)
  const entrySrcId = useStore((s) => s.settings.entrySoundSrcId)
  const patch = useStore((s) => s.patchSettings)
  const [entryOpen, setEntryOpen] = useState(false)
  // 有効でも音源が未選択・見つからなければ鳴らないので、スイッチとは別に説明で伝える
  // (判定は EntrySoundDialog の補足行と揃える)
  const entryDescription =
    entrySrcId === ''
      ? 'サウンドが未選択のため鳴りません'
      : !sounds.some((s) => s.id === entrySrcId)
        ? `「${entrySrcId}」が見つかりません（ファイルが移動・削除された可能性）`
        : entrySrcId

  return (
    <>
      <header className="vc-popout-header relative z-10 flex h-16 shrink-0 items-center gap-2 p-3">
        <IconButton label="サウンドボードに戻る" onClick={() => setView('main')} className="h-8 w-8">
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <h2 className="text-base font-semibold">VoiceCord の設定</h2>
      </header>
      {/* Discord 純正の設定と同じく、よく触るものから順に 1 ページの行で並べる。
          診断は普段見ないので最後に畳んで置く。 */}
      <div className="flex h-[456px] min-h-0 shrink flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-4">
            <VolumeSection />
            <MonitorSection />
            <section aria-label="入場サウンド">
              <h3 className="text-xs font-semibold text-muted-foreground">入場サウンド</h3>
              <div>
                <SettingsRow
                  label="VC に入ったら自動で鳴らす"
                  description={<span className="break-all">{entryDescription}</span>}
                  control={
                    <>
                      <Switch
                        aria-label="VC に入ったら自動で鳴らす"
                        checked={entryEnabled}
                        onCheckedChange={(checked) => patch({ entrySoundEnabled: checked })}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label="入場サウンドの設定を開く"
                        onClick={() => setEntryOpen(true)}
                      >
                        設定
                      </Button>
                    </>
                  }
                />
              </div>
            </section>
            <section aria-label="サウンドフォルダ">
              <h3 className="text-xs font-semibold text-muted-foreground">サウンドフォルダ</h3>
              <div>
                <SettingsRow
                  // 空白の無い長いフォルダ名でも右のボタンに重ならないよう、どこでも折り返す
                  label={
                    <span className="break-all font-semibold">{folder ? folderName(folder) : 'フォルダ未選択'}</span>
                  }
                  description={folder && <span className="break-all font-mono text-[11px]">{folder}</span>}
                  control={
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label="サウンドフォルダを選ぶ"
                        onClick={() => void chooseFolder()}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        選ぶ
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label="サウンドフォルダを再読込"
                        onClick={() => void reload()}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        再読込
                      </Button>
                    </>
                  }
                />
              </div>
            </section>
            <section aria-label="表示">
              <h3 className="text-xs font-semibold text-muted-foreground">表示</h3>
              <div>
                <SettingsRow
                  label="ビデオボタンを隠して横一列に並べる"
                  description="音声パネルのビデオボタンを隠し、VoiceCord のボタンを純正のボタンと横一列に並べます。オフのときはサウンドボードの下に 2 段で並べます"
                  control={
                    <Switch
                      aria-label="ビデオボタンを隠して横一列に並べる"
                      checked={hideCamera}
                      onCheckedChange={(checked) => patch({ hideCameraButton: checked })}
                    />
                  }
                />
              </div>
            </section>
            <section aria-label="サウンドボード">
              <h3 className="text-xs font-semibold text-muted-foreground">サウンドボード</h3>
              <div>
                <SettingsRow
                  label="ほかのサーバーのサウンドを VoiceCord で鳴らす"
                  description="Nitro が必要なサウンドをクリックしたとき、音声を取得して VoiceCord から再生します。サーバーの管理者が外部のサウンドを禁止している場合も鳴ります。Discord の利用規約に反する可能性があります"
                  control={
                    <Switch
                      aria-label="ほかのサーバーのサウンドを VoiceCord で鳴らす"
                      checked={unlockSoundboard}
                      onCheckedChange={(checked) => patch({ unlockSoundboard: checked })}
                    />
                  }
                />
              </div>
            </section>
            <StatusSection />
          </div>
        </ScrollArea>
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
        // フォーカスが外へ移っただけでは閉じない。純正のサウンドボードを開いたまま VoiceCord を開くと、
        // 純正側が閉じるときに自分のボタンへフォーカスを戻し、開いた直後に閉じてしまう。
        // 閉じるのは外側のクリック・Esc・VoiceCord ボタンだけにする
        onFocusOutside={(e) => e.preventDefault()}
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
