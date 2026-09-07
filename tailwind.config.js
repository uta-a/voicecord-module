import tailwindcssAnimate from 'tailwindcss-animate'

/**
 * Tailwind の設定。移植元（VoiceCord/desktop）の theme をそのまま持ち込み、
 * Discord の DOM に同居させるための 2 点だけを足してある。
 *
 * preflight は切る。あれは html / body / * を無条件に書き換えるので、
 * 入れた瞬間に Discord 側のリセットを上書きしてしまう。代わりに
 * assets/index.css に #vc-root 配下だけのリセットを手書きしてある。
 *
 * important にセレクタを渡すと、全ユーティリティが `#vc-root .flex{...}` の形になる。
 * 詳細度が (0,1,1,0) になり、Discord のクラス（ほぼ (0,1,0,0)）に必ず勝つ。
 * prefix は付けない。付けるとコンポーネントの className を全部書き換えることになり、
 * 移植元との差分が追えなくなる。
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./src/ui/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  important: '#vc-root',
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))'
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        toolbar: 'hsl(var(--toolbar))',
        sidebar: 'hsl(var(--sidebar))',
        'card-hover': 'hsl(var(--card-hover))'
      },
      fontFamily: {
        display: ['Bahnschrift', 'Segoe UI Variable', 'Segoe UI', 'sans-serif']
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
}
