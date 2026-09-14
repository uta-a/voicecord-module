import { create } from 'zustand'
import type { VoiceCordStatus } from '@shared/ipc'

/**
 * ポップアウトの開閉と、preload から渡される「器側の事情」。
 *
 * エンジンの操作や音源の状態は store.ts が持つ。ここに置くのは、UI バンドルの外
 * （preload）が決めるもの — どの要素にアンカーするか、mod 自身が健在か、純正ボタンの
 * 発見が何段目か — だけ。preload と UI は別バンドルなので、entry.ts の窓口経由で書き込む。
 */

export type EntryMode = 'graft' | 'fab' | 'none'

export interface AnchorInfo {
  mode: EntryMode
  /** 純正ボタンを何段目で見つけたか（anchor.ts）。見つかっていなければ null */
  tier: 1 | 2 | 3 | 4 | null
  inserts: number
  tripped: boolean
  /** 採取役の状況（診断用の短い文） */
  harvest: string
  /** FAB に退避している理由 */
  fabReason: string | null
}

export type PopoutView = 'main' | 'settings'

interface PopoutState {
  open: boolean
  anchor: HTMLElement | null
  view: PopoutView
  status: VoiceCordStatus | null
  anchorInfo: AnchorInfo | null
  setOpen: (open: boolean) => void
  setView: (view: PopoutView) => void
}

export const usePopout = create<PopoutState>((set) => ({
  open: false,
  anchor: null,
  view: 'main',
  status: null,
  anchorInfo: null,
  // 閉じたら次に開いたときはサウンドの一覧から始める（純正と同じ）
  setOpen: (open) => set(open ? { open } : { open, view: 'main' }),
  setView: (view) => set({ view })
}))
