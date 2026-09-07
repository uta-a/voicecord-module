import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ビルド。esbuild だけで完結させる（Vite も electron-vite も使わない）。
 *
 * 成果物は payload/ に集める。マネージャの「適用」がこれを
 * %LOCALAPPDATA%\VoiceCord\dist\ へコピーする。開発中は payload/ に
 * ジャンクションを張っておけば、ビルドするだけで反映される。
 *
 *   mklink /J "%LOCALAPPDATA%\VoiceCord\dist" "<repo>\payload"
 */

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(root, 'payload')
const tmpDir = path.join(root, '.tmp')
const watch = process.argv.includes('--watch')

/** CSS が無い段階でも動くように、存在するときだけ取り込む */
const uiCssPath = path.join(tmpDir, 'ui.css')

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // electron は実行時に Discord のものを使う。バンドルしてはいけない
  external: ['electron', 'original-fs'],
  sourcemap: true,
  logLevel: 'info'
}

const targets = [
  {
    name: 'patcher',
    entry: 'src/patcher/index.ts',
    out: 'patcher.js',
    // Discord の main プロセスで動く。CJS でなければ shim から require できない
    options: {}
  },
  {
    name: 'preload',
    entry: 'src/preload/index.ts',
    out: 'preload.js',
    options: {
      // CSS は文字列として取り込み、adoptedStyleSheets で流し込む。
      // <link> にすると CSP の style-src に当たる
      loader: { '.css': 'text' }
    }
  }
]

/**
 * 出力に eval / new Function が混ざっていないか検査する。
 *
 * UI は preload の isolated world で動くので CSP とは無縁だが、
 * 万一メインワールドへ載せ替えることになったときに script-src の
 * unsafe-eval が必要になるのを避けたい。混入は依存の入れ替えで
 * 静かに起きるので、ビルドのたびに機械的に見る。
 */
function checkNoEval(file) {
  const source = fs.readFileSync(file, 'utf8')
  const hits = []
  for (const [label, re] of [
    ['eval(', /(^|[^.\w$])eval\s*\(/g],
    ['new Function', /new\s+Function\s*\(/g]
  ]) {
    const m = source.match(re)
    if (m) hits.push(`${label} x${m.length}`)
  }
  return hits
}

async function buildOne(t) {
  const outfile = path.join(outDir, t.out)
  await build({
    ...common,
    ...t.options,
    entryPoints: [path.join(root, t.entry)],
    outfile
  })
  return outfile
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  if (!fs.existsSync(uiCssPath)) {
    fs.mkdirSync(tmpDir, { recursive: true })
    // UI 移植（M1-e）より前は空の CSS で通す
    fs.writeFileSync(uiCssPath, '/* placeholder: tailwind の出力は M1-e で入る */\n')
  }

  const built = []
  for (const t of targets) {
    if (!fs.existsSync(path.join(root, t.entry))) {
      console.log(`skip ${t.name}（${t.entry} がまだ無い）`)
      continue
    }
    built.push({ name: t.name, file: await buildOne(t) })
  }

  // frida エージェントは無改造でそのまま置く（開発中にホット差し替えできる）
  const hookSrc = path.join(root, 'src/agent/hook.js')
  if (fs.existsSync(hookSrc)) {
    fs.copyFileSync(hookSrc, path.join(outDir, 'hook.js'))
    console.log('copied hook.js')
  }

  let failed = false
  for (const b of built) {
    const hits = checkNoEval(b.file)
    if (hits.length > 0) {
      console.error(`✗ ${b.name}: ${hits.join(', ')} が混入しています`)
      failed = true
    }
  }
  if (failed) process.exit(1)

  console.log(`built: ${built.map((b) => b.name).join(', ') || '(なし)'}`)
}

if (watch) {
  console.error('--watch はまだ実装していません')
  process.exit(1)
}

await main()
