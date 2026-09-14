import { useEffect, useState } from 'react'

/**
 * Discord の現在のテーマ。Discord は <html> に theme-light / theme-dark を付け替える。
 * CSS の配色は変数の継承で勝手に追従するが、sonner のように JS でテーマを受け取る
 * 部品にはこれを渡す。
 */
export type DiscordTheme = 'light' | 'dark'

export function discordTheme(doc: Document): DiscordTheme {
  return doc.documentElement.classList.contains('theme-light') ? 'light' : 'dark'
}

export function useDiscordTheme(): DiscordTheme {
  const [theme, setTheme] = useState<DiscordTheme>(() =>
    typeof document === 'undefined' ? 'dark' : discordTheme(document)
  )
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => setTheme(discordTheme(document)))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return theme
}
