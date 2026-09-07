/**
 * スタイルの注入。
 *
 * CSSOM（adoptedStyleSheets / insertRule）で入れる。<link> や
 * <style> の innerHTML と違って CSP の style-src の対象にならないため、
 * Discord の CSP を一切書き換えずに済む。
 *
 * これは Vencord との共存要件でもある。Vencord は自分の CSP ハンドラを
 * 登録したあと webRequest.onHeadersReceived をメソッドごと noop で潰すので、
 * 後から CSP を書き換えることはそもそもできない。
 */

export type InjectMethod = 'adopted' | 'style-element'

export interface DocumentLike {
  adoptedStyleSheets?: CSSStyleSheet[]
  createElement(tag: string): HTMLElement
  head: { appendChild(node: Node): void } | null
  documentElement: { appendChild(node: Node): void }
}

/**
 * CSS を注入する。使えた手段を返す。
 * どの手段も失敗したら throw する（呼び出し側でサブシステムとして隔離される）。
 */
export function injectStyles(doc: DocumentLike, css: string): InjectMethod {
  if (typeof CSSStyleSheet !== 'undefined' && Array.isArray(doc.adoptedStyleSheets)) {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      // 既存のシートを消さずに足す
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      return 'adopted'
    } catch {
      // replaceSync が使えない環境ではフォールバックへ
    }
  }
  const el = doc.createElement('style')
  el.textContent = css
  const parent = doc.head ?? doc.documentElement
  parent.appendChild(el)
  return 'style-element'
}
