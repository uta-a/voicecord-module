/**
 * preload はセッション単位で登録されるので、Discord の全フレームで走る。
 * UI を出してよい場所かどうかをここで判定する。
 *
 * ポップアウト窓は top-level なので `window.top !== window` では捕まらない。
 * しかも Discord の POPOUT_OPTIONS には contextIsolation:true はあるが
 * sandbox:false が無い（Canary 1.0.1099 / Stable 1.0.9256 の core.asar で確認）。
 * つまり sandbox 有効で走るので、別扱いにして UI を出さない。
 */

export interface FrameInfo {
  /** location.protocol（'https:' / 'data:' など） */
  protocol: string
  hostname: string
  pathname: string
  /** window.top === window か */
  isTop: boolean
  /** window.opener が居るか */
  hasOpener: boolean
}

export type MountDecision = { mount: true } | { mount: false; reason: string }

export function shouldMount(f: FrameInfo): MountDecision {
  // splash ウィンドウは data: URL で読み込まれる
  if (f.protocol === 'data:') return { mount: false, reason: 'splash' }
  if (!f.isTop) return { mount: false, reason: 'iframe' }
  if (!isDiscordHost(f.hostname)) return { mount: false, reason: `host=${f.hostname}` }
  // ポップアウト（ボイスパネルなど）。sandbox 有効で走るうえ、
  // 小さな別窓に FAB が出ても邪魔にしかならない
  if (f.hasOpener) return { mount: false, reason: 'popout (opener)' }
  if (/(^|\/)popout(\/|$)/.test(f.pathname)) return { mount: false, reason: 'popout (path)' }
  return { mount: true }
}

/** discord.com とそのサブドメインだけを受け入れる（discord.com.evil.test を弾く） */
export function isDiscordHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'discord.com' || h.endsWith('.discord.com')
}

/** 実行中のウィンドウから FrameInfo を組み立てる */
export function frameInfoOf(win: Window): FrameInfo {
  return {
    protocol: win.location.protocol,
    hostname: win.location.hostname,
    pathname: win.location.pathname,
    isTop: win.top === win,
    hasOpener: win.opener != null
  }
}
