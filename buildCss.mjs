import autoprefixer from 'autoprefixer'
import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import tailwindConfig from './tailwind.config.js'

/**
 * UI の CSS を事前コンパイルする。esbuild は CSS を文字列として取り込むだけなので、
 * Tailwind はここで通しておく。
 *
 * ビルドとテストの両方から呼べるように、書き出しはせず文字列を返す。
 */

export const ROOT_SELECTOR = '#vc-root'

/**
 * 取りこぼしたセレクタを #vc-root の下へ落とす。
 *
 * Tailwind の important: '#vc-root' はユーティリティしか包まない。base 層に出る
 * `*, ::before, ::after, ::backdrop { --tw-*: ... }`（ユーティリティが参照する変数の
 * 既定値）は素通しで、そのままだと Discord の全要素に 25 個の custom property が乗る。
 * 「1 つも漏らさない」を仕組みで保証したいので、最後に機械的に均す。
 */
export const scopeToRoot = {
  postcssPlugin: 'voicecord-scope-to-root',
  Rule(rule) {
    // @keyframes の中身は from / to / パーセントなので触ってはいけない
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type === 'atrule' && p.name.endsWith('keyframes')) return
    }
    rule.selectors = rule.selectors.map((raw) => {
      const s = raw.trim()
      return s.startsWith(ROOT_SELECTOR) ? s : `${ROOT_SELECTOR} ${s}`
    })
  }
}

/** 入力の CSS。移植元の renderer と同じ 1 枚だけ */
export const UI_CSS_ENTRY = 'src/ui/assets/index.css'

/** Tailwind を通した CSS を返す。root はリポジトリのルート */
export async function compileUiCss(root) {
  const from = path.join(root, UI_CSS_ENTRY)
  const source = fs.readFileSync(from, 'utf8')
  // 設定をオブジェクトで渡すと content の glob は cwd 基準になる。cwd に依存させたくないので
  // ここで root 基準へ直す（glob なので区切りは / のまま）
  const posixRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
  const config = {
    ...tailwindConfig,
    content: tailwindConfig.content.map((g) => `${posixRoot}/${g.replace(/^\.\//, '')}`)
  }
  const result = await postcss([tailwindcss(config), autoprefixer, scopeToRoot]).process(source, {
    from
  })
  return result.css
}
