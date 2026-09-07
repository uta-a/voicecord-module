import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from './App.js'
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
 * DOM が用意できてから require する。副次的に preload 本体が数十 KB で済み、
 * Discord の起動時に 900KB を読ませずに済む。
 */

export interface MountResult {
  css: string
  unmount: () => void
}

/** DOM が使えるようになってから呼ぶこと */
export function mount(container: HTMLElement): MountResult {
  let root: Root | null = createRoot(container)
  root.render(createElement(App))
  return {
    css: UI_CSS,
    unmount: () => {
      root?.unmount()
      root = null
    }
  }
}
