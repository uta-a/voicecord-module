import tailwindcssAnimate from 'tailwindcss-animate'

/**
 * Tailwind の設定。Discord の DOM に同居させるための 2 点と、Discord のテーマに
 * 自動で追従させるための配色の付け替えがしてある。
 *
 * preflight は切る。あれは html / body / * を無条件に書き換えるので、
 * 入れた瞬間に Discord 側のリセットを上書きしてしまう。代わりに
 * assets/index.css に #vc-root 配下だけのリセットを手書きしてある。
 *
 * important にセレクタを渡すと、全ユーティリティが `#vc-root .flex{...}` の形になる。
 * 詳細度が (0,1,1,0) になり、Discord のクラス（ほぼ (0,1,0,0)）に必ず勝つ。
 * prefix は付けない。付けるとコンポーネントの className を全部書き換えることになる。
 *
 * 配色は `--vc-*` を経由して Discord の変数を読む（index.css）。Discord の変数は
 * `color-mix(...)` や `hsl(... / a)` の生の色値なので、移植元の `hsl(var(--x))` の
 * 包み方は使えない。`bg-primary/12` のような不透明度の指定を生かすため、
 * color-mix で透明と混ぜる形にしてある（<alpha-value> は Tailwind が差し込む）。
 */

/** @param {string} name */
const token = (name) => `color-mix(in oklab, var(--vc-${name}) calc(<alpha-value> * 100%), transparent)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./src/ui/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  important: '#vc-root',
  theme: {
    extend: {
      colors: {
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        primary: {
          DEFAULT: token('primary'),
          foreground: token('primary-foreground')
        },
        secondary: {
          DEFAULT: token('secondary'),
          foreground: token('secondary-foreground')
        },
        destructive: {
          DEFAULT: token('destructive'),
          foreground: token('destructive-foreground')
        },
        success: {
          DEFAULT: token('success'),
          foreground: token('success-foreground')
        },
        warning: {
          DEFAULT: token('warning'),
          foreground: token('warning-foreground')
        },
        muted: {
          DEFAULT: token('muted'),
          foreground: token('muted-foreground')
        },
        accent: {
          DEFAULT: token('accent'),
          foreground: token('accent-foreground')
        },
        popover: {
          DEFAULT: token('popover'),
          foreground: token('popover-foreground')
        },
        card: {
          DEFAULT: token('card'),
          foreground: token('card-foreground')
        },
        toolbar: token('toolbar'),
        sidebar: token('sidebar'),
        'card-hover': token('card-hover')
      },
      fontFamily: {
        display: ['var(--font-display, "gg sans")', 'Noto Sans', 'sans-serif']
      },
      borderRadius: {
        lg: 'var(--radius-sm, 8px)',
        md: 'calc(var(--radius-sm, 8px) - 2px)',
        sm: 'var(--radius-xs, 4px)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
}
