import {
  HARVEST_REQUEST_EVENT,
  HARVEST_RESULT_EVENT,
  type ActionButtonClasses,
  type HarvestCode,
  type HarvestResult,
  type HarvestSource
} from '../shared/harvest.js'

/**
 * メインワールドの採取役。**読み取り専用。**
 *
 * Vencord の安定性の源は、DOM からクラス名を推測せず、webpack のモジュールレジストリから
 * CSS モジュールの対応表（{ actionButtons: "actionButtons_e131a9", ... }）を引くことにある。
 * webpack のグローバルはメインワールドにしか無いので、ここだけをメインワールドに置く。
 *
 * 守っていること:
 *   - window.api も IPC も持たない。Discord の関数は 1 つも呼ばない（モジュールの exports を読むだけ）
 *   - 受け渡しは素の文字列だけ（CustomEvent の detail に JSON 文字列）。理由は自由文ではなくコード
 *   - eval / new Function を使わない（メインワールドは CSP の unsafe-eval 制限を受ける）
 *   - **Function.prototype に一切触らない。** Vencord は `Function.prototype.m` に
 *     configurable:false の setter を仕掛けて webpack の require を捕まえている。
 *     同じ手を使うと後から定義した側が TypeError で落ちる（Stable には Vencord が居る）
 *   - window や Proxy らしきもの（Discord の i18n の Proxy など）は読まない。Vencord の
 *     モジュール検索も同じものを読み飛ばしている。Proxy の get を踏むと副作用がありうる
 */

/** webpack のモジュールキャッシュ（__webpack_require__.c）の値 */
interface ModuleRecord {
  exports?: unknown
}

export interface HarvestWindow {
  Vencord?: { Webpack?: { cache?: unknown; wreq?: { c?: unknown } } }
  webpackChunkdiscord_app?: unknown
}

/**
 * 読んではいけない exports。
 * ES モジュールの名前空間は Symbol.toStringTag が 'Module'、CSS モジュールの対応表は素の
 * オブジェクトで undefined。それ以外のタグ（'Window'、'IntlMessagesProxy' など）は読み飛ばす。
 */
function isSuspicious(ex: object, win: unknown): boolean {
  if (ex === win || ex === globalThis) return true
  try {
    const tag = (ex as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]
    return tag !== undefined && tag !== 'Module'
  } catch {
    return true
  }
}

/** CSS モジュールらしい exports から、音声パネルのボタン列のクラス名を拾う */
export function findActionButtonClasses(
  exportsList: Iterable<unknown>,
  win?: unknown
): ActionButtonClasses | null {
  for (const ex of exportsList) {
    for (const candidate of candidatesOf(ex, win)) {
      const found = pick(candidate)
      if (found !== null) return found
    }
  }
  return null
}

function candidatesOf(ex: unknown, win: unknown): object[] {
  if (typeof ex !== 'object' || ex === null || isSuspicious(ex, win)) return []
  const out: object[] = [ex]
  try {
    // ESM 由来の CSS モジュールは default の下に対応表を持つことがある
    const d = (ex as { default?: unknown }).default
    if (typeof d === 'object' && d !== null && !isSuspicious(d, win)) out.push(d)
  } catch {
    // getter が throw しても他の候補は見る
  }
  return out
}

function pick(obj: object): ActionButtonClasses | null {
  try {
    const o = obj as Record<string, unknown>
    // 「列」「ボタン」「アイコン」が揃っているものだけ。actionButtons 単独のキーは
    // 他の画面にもありうるので、組み合わせで絞る。返すのは実際に使う列のクラスだけ
    if (
      typeof o['actionButtons'] !== 'string' ||
      typeof o['buttonIcon'] !== 'string' ||
      typeof o['button'] !== 'string'
    ) {
      return null
    }
    return { actionButtons: o['actionButtons'] }
  } catch {
    return null
  }
}

/** キャッシュ（{ id: { exports } }）から exports を列挙する */
function exportsOf(cache: unknown): unknown[] {
  if (typeof cache !== 'object' || cache === null) return []
  const out: unknown[] = []
  for (const key of Object.keys(cache)) {
    try {
      const rec = (cache as Record<string, ModuleRecord | undefined>)[key]
      if (rec && typeof rec === 'object') out.push(rec.exports)
    } catch {
      // 1 モジュールの失敗で全体を諦めない
    }
  }
  return out
}

/**
 * webpack のモジュールキャッシュを手に入れる。
 *
 *   1. Vencord が居ればその解決済みのキャッシュを借りる（二重に掴まない）
 *   2. 居なければ webpackChunkdiscord_app に空のチャンクを積み、runtime 関数で
 *      __webpack_require__ を受け取る。積んだものはすぐ取り除く
 */
export function moduleCache(win: HarvestWindow): {
  source: HarvestSource
  cache: unknown
  code: HarvestCode | null
} {
  try {
    const w = win.Vencord?.Webpack
    if (w) {
      const cache = w.cache ?? w.wreq?.c
      if (typeof cache === 'object' && cache !== null) return { source: 'vencord', cache, code: null }
    }
  } catch {
    // Vencord の形が変わっていても webpack の経路を試す
  }

  const chunk = win.webpackChunkdiscord_app
  if (!Array.isArray(chunk) || typeof chunk.push !== 'function') {
    return { source: 'none', cache: null, code: 'no-webpack' }
  }
  let req: { c?: unknown } | undefined
  const marker = Symbol('voicecord-harvest')
  const before = chunk.length
  try {
    chunk.push([[marker], {}, (r: { c?: unknown }) => {
      req = r
    }])
  } catch {
    return { source: 'none', cache: null, code: 'push-failed' }
  } finally {
    // 積んだ空チャンクを残さない。webpack の runtime がまだ動いていなければ
    // 素の Array の push として末尾に残っているので、それも消す
    try {
      const last = chunk[chunk.length - 1] as unknown[] | undefined
      if (chunk.length > before && Array.isArray(last) && Array.isArray(last[0]) && last[0][0] === marker) {
        chunk.pop()
      }
    } catch {
      // 後始末に失敗しても空チャンクは無害
    }
  }
  if (!req || typeof req.c !== 'object' || req.c === null) {
    return { source: 'none', cache: null, code: 'no-require' }
  }
  return { source: 'webpack', cache: req.c, code: null }
}

export function harvestOnce(win: HarvestWindow): HarvestResult {
  const { source, cache, code } = moduleCache(win)
  if (cache === null) return { source, classes: null, code }
  const classes = findActionButtonClasses(exportsOf(cache), win)
  // 音声パネルの CSS は VC に入って初めて読み込まれるので、見つからないのは異常ではない
  return { source, classes, code: classes === null ? 'module-not-loaded' : null }
}

export interface HarvestDocument {
  addEventListener(type: string, listener: () => void): void
  dispatchEvent(event: Event): boolean
}

const INSTALLED = Symbol.for('voicecord.harvest.installed')

/** 一度だけ仕掛ける。要求が来るたびに引き直して結果を投げる */
export function installHarvester(
  win: HarvestWindow,
  doc: HarvestDocument,
  makeEvent: (type: string, detail: string) => Event
): boolean {
  const flags = win as Record<symbol, unknown>
  if (flags[INSTALLED]) return false
  flags[INSTALLED] = true
  const run = (): void => {
    let result: HarvestResult
    try {
      result = harvestOnce(win)
    } catch {
      result = { source: 'none', classes: null, code: 'exception' }
    }
    doc.dispatchEvent(makeEvent(HARVEST_RESULT_EVENT, JSON.stringify(result)))
  }
  doc.addEventListener(HARVEST_REQUEST_EVENT, run)
  run()
  return true
}
