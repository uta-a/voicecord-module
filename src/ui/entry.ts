import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import type { VoiceCordStatus } from '../shared/ipc.js'
import App from './App.js'
import { usePopout, type AnchorInfo } from './popout.js'
import { useStore } from './store.js'
import UI_CSS from '../../.tmp/ui.css'

/**
 * UI バンドルの入口。preload とは別ファイルに分けてある。
 *
 * preload はウィンドウが作られる前に読み込まれるので、その時点では
 * document.head がまだ無い。UI の依存の中には（sonner のように）モジュールの
 * トップレベルで document.head.appendChild を呼ぶものがあり、preload と同じ
 * バンドルに入れると読み込みの瞬間に TypeError で落ちる。Electron は preload の
 * 例外を握り潰さないので、UI どころか FAB ごと出なくなる。
 *
 * 依存を 1 つずつ潰すのは追いかけっこになるので、UI はまるごと別ファイルにして
 * DOM が用意できてから require する。
 *
 * preload からは下の窓口だけで操作する。ポップアウトをどの要素に付けるか
 * （接ぎ木したボタンか、故障時の FAB か）は preload が決める。
 */

export interface UiController {
  css: string
  unmount: () => void
  /** ポップアウトのアンカー。null なら開かない */
  setAnchor: (el: HTMLElement | null) => void
  setOpen: (open: boolean) => void
  toggle: () => void
  isOpen: () => boolean
  onOpenChange: (cb: (open: boolean) => void) => () => void
  setStatus: (s: VoiceCordStatus) => void
  setAnchorInfo: (info: AnchorInfo) => void
  /** Discord のトーストの代わり。1 回だけ出したい警告に使う */
  notify: (msg: string) => void
  /** 純正サウンドボードで押された、Nitro が必要なサウンドを VoiceCord から鳴らす */
  playSoundboardSound: (sound: { soundId: string; name: string }) => void
}

/** DOM が使えるようになってから呼ぶこと */
export function mount(container: HTMLElement): UiController {
  let root: Root | null = createRoot(container)
  root.render(createElement(App))
  const st = usePopout
  return {
    css: UI_CSS,
    unmount: () => {
      root?.unmount()
      root = null
    },
    setAnchor: (el) => {
      if (st.getState().anchor === el) return
      st.setState({ anchor: el })
      if (el === null) st.getState().setOpen(false)
    },
    setOpen: (open) => st.getState().setOpen(open && st.getState().anchor !== null),
    toggle: () => {
      const s = st.getState()
      s.setOpen(!s.open && s.anchor !== null)
    },
    isOpen: () => st.getState().open,
    onOpenChange: (cb) =>
      st.subscribe((s, prev) => {
        if (s.open !== prev.open) cb(s.open)
      }),
    setStatus: (s) => st.setState({ status: s }),
    setAnchorInfo: (info) => st.setState({ anchorInfo: info }),
    notify: (msg) => {
      toast(msg, { duration: 8000 })
    },
    playSoundboardSound: ({ soundId, name }) => {
      void useStore.getState().playSoundboardSound(soundId, name)
    }
  }
}
