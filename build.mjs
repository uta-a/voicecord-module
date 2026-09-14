import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileUiCss } from './buildCss.mjs'

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
const managerDir = path.join(root, 'dist-manager')
const tmpDir = path.join(root, '.tmp')
const watch = process.argv.includes('--watch')

/** Tailwind の出力。preload が文字列として取り込む */
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
    // UI は preload とは別のファイルにする。preload はウィンドウが作られる前に
    // 読み込まれるので document.head がまだ無く、モジュールのトップレベルで
    // document.head を触る依存（sonner など）が入っていると読み込みの瞬間に
    // 落ちる。Electron は preload の例外を握り潰さないので、FAB ごと出なくなる。
    name: 'ui',
    entry: 'src/ui/entry.ts',
    out: 'ui.js',
    options: {
      loader: { '.css': 'text' },
      jsx: 'automatic',
      alias: {
        '@': path.join(root, 'src/ui'),
        '@shared': path.join(root, 'src/shared')
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      mainFields: ['module', 'main']
    }
  },
  {
    name: 'preload',
    entry: 'src/preload/index.ts',
    out: 'preload.js',
    options: {
      // ui.js は実行時に require する。バンドルに巻き込まない
      external: [...common.external, './ui.js']
    }
  },
  {
    // メインワールドの採取役。preload が文字列で読み、webFrame.executeJavaScript で
    // メインワールドへ流し込む。Node も electron も無い素のページで動くので iife にする。
    // ソースマップは付けない（ページの URL 基準で .map を取りに行ってしまう）
    name: 'harvest',
    entry: 'src/mainworld/index.ts',
    out: 'harvest.js',
    options: {
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      external: [],
      sourcemap: false
    }
  }
]

/**
 * frida のランタイムを payload へ配る。
 *
 * バンドルに巻き込んではいけない。frida は `bindings` パッケージで
 * frida_binding.node を探しており、bindings は呼び出し元のディレクトリから
 * 上へ辿って package.json と build/ を見つける。束ねると辿れなくなる。
 *
 * frida 本体は package.json と build/ だけあれば動く（src / releng /
 * subprojects / test は配布に要らない）。prebuild-install はインストール時に
 * しか使わないので連れて行かない。
 */
const FRIDA_RUNTIME_DEPS = ['bindings', 'file-uri-to-path', 'minimatch', 'brace-expansion', 'balanced-match']

/** 同じ内容ならコピーしない。frida のバイナリは 75MB あり、毎回コピーすると遅い */
function copyIfChanged(from, to) {
  try {
    const a = fs.statSync(from)
    const b = fs.statSync(to)
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return false
  } catch {
    // 宛先が無い。コピーする
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return true
}

function copyTree(from, to) {
  let n = 0
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, e.name)
    const t = path.join(to, e.name)
    if (e.isDirectory()) n += copyTree(f, t)
    else if (copyIfChanged(f, t)) n += 1
  }
  return n
}

function copyFrida() {
  const src = path.join(root, 'node_modules')
  const dst = path.join(outDir, 'node_modules')
  if (!fs.existsSync(path.join(src, 'frida'))) {
    console.log('skip frida（node_modules に入っていない）')
    return
  }
  let n = 0
  n += copyIfChanged(
    path.join(src, 'frida/package.json'),
    path.join(dst, 'frida/package.json')
  )
  n += copyTree(path.join(src, 'frida/build'), path.join(dst, 'frida/build'))
  for (const d of FRIDA_RUNTIME_DEPS) {
    const from = path.join(src, d)
    if (!fs.existsSync(from)) {
      console.error(`✗ frida の実行時依存が見つかりません: ${d}`)
      process.exit(1)
    }
    n += copyTree(from, path.join(dst, d))
  }
  console.log(`frida ランタイム: ${n} ファイルを更新`)
}

/**
 * エンジン。utilityProcess.fork の子として Node のモジュールローダに読まれるので
 * ESM のまま出す。frida は packages:'external' で import 文のまま残す
 * （バンドルに巻き込むと bindings が module_root を辿れなくなる）。
 *
 * M2 の実体はスタブ。M3 で src/engine/engine.mjs に差し替える。
 */
async function buildEngine() {
  // 本物 → スタブ の順に探す。M3 以降は engine.ts が居る
  const entry = ['src/engine/engine.ts', 'src/engine/engine.mjs', 'src/engine/stub.mjs'].find((e) =>
    fs.existsSync(path.join(root, e))
  )
  if (entry === undefined) throw new Error('エンジンの入口がありません')
  const outfile = path.join(outDir, 'engine.mjs')
  await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
    logLevel: 'info',
    entryPoints: [path.join(root, entry)],
    outfile
  })
  console.log(`built: engine.mjs (${entry})`)
  return { name: 'engine', file: outfile }
}

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

/**
 * マネージャ（VoiceCord.exe）。Discord の中で動くペイロードとは別物なので
 * 出力先も分ける。ルートの package.json が type:module なので、出力先に
 * commonjs 宣言を置いて .js を CJS として読ませる。
 */
async function buildManager() {
  fs.mkdirSync(managerDir, { recursive: true })
  // ルートの package.json が type:module なので、ここに commonjs 宣言を置いて
  // dist-manager 配下の .js を CJS として読ませる
  fs.writeFileSync(
    path.join(managerDir, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'
  )

  await build({
    ...common,
    entryPoints: [path.join(root, 'src/manager/main/index.ts')],
    outfile: path.join(managerDir, 'main.js')
  })
  await build({
    ...common,
    entryPoints: [path.join(root, 'src/manager/main/managerPreload.ts')],
    outfile: path.join(managerDir, 'managerPreload.js')
  })
  await build({
    ...common,
    format: 'iife',
    platform: 'browser',
    entryPoints: [path.join(root, 'src/manager/renderer/manager.ts')],
    outfile: path.join(managerDir, 'manager.js')
  })
  fs.copyFileSync(
    path.join(root, 'src/manager/renderer/manager.html'),
    path.join(managerDir, 'manager.html')
  )
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  // preload をバンドルする前に置く。esbuild が文字列として取り込む
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(uiCssPath, await compileUiCss(root))
  console.log(`built: ui.css (${fs.statSync(uiCssPath).size} bytes)`)

  await buildManager()

  const built = []
  if (fs.existsSync(path.join(root, 'src/engine'))) {
    built.push(await buildEngine())
    copyFrida()
  }
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
