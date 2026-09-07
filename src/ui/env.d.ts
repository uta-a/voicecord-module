/**
 * Tailwind の出力（.tmp/ui.css）は esbuild の `loader: { '.css': 'text' }` で
 * 文字列として取り込む。<link> にすると CSP の style-src に当たるため、
 * CSSOM 経由で入れる（styles.ts）。
 */
declare module '*.css' {
  const css: string
  export default css
}
