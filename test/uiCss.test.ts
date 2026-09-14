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
    expect(css).toMatch(/#vc-root \{[\s\S]*?--vc-background:/)
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

describe('#vc-root 自身は塗らない', () => {
  /**
   * #vc-root は position:fixed / inset:0 の全画面オーバーレイ。ここに不透明な
   * 塗りが当たると Discord 全体を覆い隠す。しかも pointer-events:none で
   * クリックは透過するので「操作はできるのに画面が真っ黒」という、原因の
   * 分かりにくい壊れ方をする。実機で踏んだので機械的に見る。
   *
   * 継承するだけの指定（color / font / letter-spacing）は塗らないので対象外。
   */
  const PAINTING = /^(background|box-shadow|backdrop-filter|outline)/

  it('ビルド済み CSS で #vc-root 自身に塗りの宣言が無い', () => {
    const offenders: string[] = []
    postcss.parse(css).walkRules((rule: Rule) => {
      if (inKeyframes(rule.parent as Container)) return
      // 「#vc-root」ちょうどに当たるセレクタだけを見る。
      // 子孫（#vc-root .vc-body など）はパネルの中なので塗ってよい
      const hitsRootItself = rule.selectors.some((s) => s.trim() === ROOT_SELECTOR)
      if (!hitsRootItself) return
      rule.walkDecls((d) => {
        if (PAINTING.test(d.prop)) offenders.push(`${rule.selector} { ${d.prop}: ${d.value} }`)
      })
    })
    expect(offenders).toEqual([])
  })

  it('器のスタイル（SHELL_CSS）でも #vc-root 自身を塗らない', async () => {
    const { SHELL_CSS } = await import('../src/preload/shell.js')
    const offenders: string[] = []
    postcss.parse(SHELL_CSS).walkRules((rule: Rule) => {
      if (!rule.selectors.some((s) => s.trim() === ROOT_SELECTOR)) return
      rule.walkDecls((d) => {
        if (PAINTING.test(d.prop)) offenders.push(`${rule.selector} { ${d.prop}: ${d.value} }`)
      })
    })
    expect(offenders).toEqual([])
  })

  it('ポップアウトには塗りが当たっている（背景を失っていないこと）', () => {
    // 上の検査を「塗りを全部消す」で通してしまわないための対の検査。
    // M4.5 で旧パネル（.vc-body）は廃止し、塗りはポップアウト（.vc-popout）が持つ
    let painted = false
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('.vc-popout')) return
      rule.walkDecls((d) => {
        if (/^background/.test(d.prop)) painted = true
      })
    })
    expect(painted).toBe(true)
  })
})

describe('Discord のテーマに追従する', () => {
  it('配色の変数は Discord の変数を参照し、全てにフォールバック値がある', () => {
    const decls: string[] = []
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selectors.some((s) => s.trim() === ROOT_SELECTOR)) return
      rule.walkDecls((d) => {
        if (d.prop.startsWith('--vc-')) decls.push(`${d.prop}: ${d.value}`)
      })
    })
    expect(decls.length).toBeGreaterThan(20)
    // var(--x) だけだと、Discord が変数名を変えた瞬間に無色になる
    const noFallback = decls.filter((d) => /var\(--[\w-]+\)/.test(d))
    expect(noFallback).toEqual([])
  })

  it('移植元の固定色（hsl の三つ組）が残っていない', () => {
    expect(css).not.toMatch(/hsl\(var\(--/)
  })
})
