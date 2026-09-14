import { useEffect } from 'react'
import { toast } from 'sonner'
import { SoundboardPopout } from '@/components/SoundboardPopout'
import { LevelDialog } from '@/components/LevelDialog'
import { Toaster } from '@/components/ui/sonner'
import { useStore } from '@/store'

/**
 * UI の根。画面に常設するものは無い。ポップアウトもダイアログも Portal で
 * #vc-root .vc-portal に出る（M4.5 で旧フローティングパネルは廃止した）。
 */
function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  // 同じ文言が続けて出ることは普通にある(同じ操作を繰り返す、同じ原因で連続して失敗する)。
  // 連番を一緒に見て、通知されるたびに必ず出す。
  const notice = useStore((s) => s.notice)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (notice.msg) toast(notice.msg)
  }, [notice])

  return (
    <>
      <SoundboardPopout />
      {/* 音量調整はフェーダー横と設定画面の両方から開くので、実体はここに 1 つだけ置く。 */}
      <LevelDialog />
      <Toaster />
    </>
  )
}

export default App
