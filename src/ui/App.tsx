import { useEffect } from 'react'
import { toast } from 'sonner'
import { TopBar } from '@/components/TopBar'
import { SoundGrid } from '@/components/SoundGrid'
import { NowPlaying } from '@/components/NowPlaying'
import { SettingsTabs } from '@/components/SettingsTabs'
import { LevelDialog } from '@/components/LevelDialog'
import { Toaster } from '@/components/ui/sonner'
import { useStore } from '@/store'

function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  // 同じ文言が続けて出ることは普通にある(同じ操作を繰り返す、同じ原因で連続して失敗する)。
  // status の文字列だけを見ていると 2 回目以降は値が変わらず effect が動かないため、
  // ユーザーには「今度は何も言われなかった＝成功した」と映る。連番を一緒に見て、
  // 通知されるたびに必ず出す。
  const notice = useStore((s) => s.notice)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (notice.msg) toast(notice.msg)
  }, [notice])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
        <main className="flex min-h-0 flex-col border-r bg-background">
          <SoundGrid />
        </main>
        <aside className="flex min-h-0 flex-col bg-sidebar" aria-label="再生と設定">
          <NowPlaying />
          <SettingsTabs />
        </aside>
      </div>
      {/* 音量調整は TopBar と右レールの両方から開くので、実体はここに 1 つだけ置く。 */}
      <LevelDialog />
      <Toaster />
    </div>
  )
}

export default App
