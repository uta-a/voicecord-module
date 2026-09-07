import postcss, { type AtRule, type Container, type Rule } from 'postcss'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compileUiCss, ROOT_SELECTOR, scopeToRoot } from '../buildCss.mjs'
import tailwindConfig from '../tailwind.config.js'

/**
 * UI の CSS が #vc-root の外へ漏れないことの検査。
 *
 * これが崩れると Discord 本体の見た目が壊れる。しかも壊れ方は「フォントが少し違う」
 * のような、パッチを当てた本人からは気付きにくいものになりやすく、原因が
 * VoiceCord だと分かるまでに時間がかかる。ビルドのたびに機械的に見る。
 */

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

let css = ''

beforeAll(async () => {
  css = await compileUiCss(root)
}, 60_000)

/** @keyframes の中身は from / to / パーセントなので対象外 */
function inKeyframes(node: Container | undefined): boolean {
  for (let p = node; p; p = p.parent as Container | undefined) {
    if (p.type === 'atrule' && (p as AtRule).name.endsWith('keyframes')) return true
  }
  return false
}

function selectorsOf(source: string): string[] {
  const out: string[] = []
  // walkRules は @media / @supports の中も辿る
  postcss.parse(source).walkRules((rule: Rule) => {
    if (inKeyframes(rule.parent as Container | undefined)) return
    for (const s of rule.selectors) out.push(s.trim())
  })
  return out
}

describe('tailwind.config.js', () => {
  it('preflight を切ってある（html / body / * を書き換えさせない）', () => {
    expect(tailwindConfig.corePlugins).toEqual({ preflight: false })
  })

  it('important に #vc-root を渡してある（Discord のクラスに詳細度で勝つ）', () => {
    expect(tailwindConfig.important).toBe(ROOT_SELECTOR)
  })

  it('prefix は付けない（移植元の className をそのまま使う）', () => {
    expect(tailwindConfig.prefix).toBeUndefined()
  })
})

describe('compileUiCss', () => {
  it('セレクタが 1 つ残らず #vc-root で始まる', () => {
    const selectors = selectorsOf(css)
    expect(selectors.length).toBeGreaterThan(100)
    const leaked = selectors.filter((s) => !s.startsWith(ROOT_SELECTOR))
    expect(leaked).toEqual([])
  })

  it('@media の中も検査対象になっている', () => {
    // prefers-reduced-motion のブロックは実際に出ている。ここが 0 だと
    // 「@media を見落としたまま緑になる」テストになってしまう
    const inMedia: string[] = []
    postcss.parse(css).walkAtRules('media', (at) => {
      at.walkRules((rule) => {
        inMedia.push(...rule.selectors)
      })
    })
    expect(inMedia.length).toBeGreaterThan(0)
    expect(inMedia.filter((s) => !s.trim().startsWith(ROOT_SELECTOR))).toEqual([])
  })

  it('ユーティリティが #vc-root で包まれている', () => {
    expect(css).toContain('#vc-root .flex {')
  })

  it('preflight の代わりのリセットが入っている', () => {
    // shadcn の `border` ユーティリティは border-width:0 の既定に乗っている。
    // これが無いとブラウザ既定の medium(3px) が残り、罫線だけ太くなる
    expect(css).toMatch(/#vc-root \*[\s\S]{0,120}border-width: 0/)
    expect(css).toMatch(/#vc-root \*[\s\S]{0,120}box-sizing: border-box/)
  })

  it('CSS 変数を #vc-root にだけ置く（Discord の変数を汚さない）', () => {
    expect(css).toMatch(/#vc-root \{[\s\S]*?--background:/)
    // :root へ置いてしまうと Discord 側の変数と同じ土俵に乗る
    expect(selectorsOf(css).filter((s) => s.includes(':root'))).toEqual([])
  })
})

describe('scopeToRoot', () => {
  it('取りこぼしたセレクタを #vc-root の下へ落とす', async () => {
    const out = await postcss([scopeToRoot]).process(
      '*, ::before { color: red } #vc-root .a { color: blue }',
      { from: undefined }
    )
    expect(selectorsOf(out.css)).toEqual(['#vc-root *', '#vc-root ::before', '#vc-root .a'])
  })

  it('@keyframes の中は書き換えない', async () => {
    const out = await postcss([scopeToRoot]).process('@keyframes x { from { opacity: 0 } }', {
      from: undefined
    })
    expect(out.css).toContain('from {')
    expect(out.css).not.toContain('#vc-root from')
  })
})
