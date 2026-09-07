import { PORTAL_CLASS, ROOT_ID } from '../preload/shell.js'

/**
 * Radix の Portal に渡す container。
 *
 * 既定の document.body に出すと #vc-root の外へ抜けてしまい、#vc-root に
 * スコープした Tailwind のユーティリティが 1 つも当たらない（ダイアログや
 * セレクトが素の HTML の見た目になる）。
 *
 * 器がまだ無い場合（テストや、shell のマウント前に描画された場合）は undefined を返す。
 * Radix の Portal は container が undefined なら既定の document.body を使うので、
 * ここで落とさずに済む。
 */
export function portalContainer(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  return document.querySelector<HTMLElement>(`#${ROOT_ID} .${PORTAL_CLASS}`) ?? undefined
}
