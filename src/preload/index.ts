import { ipcRenderer, webFrame } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { UiController } from '../ui/entry.js'
import type { VoiceCordStatus } from '../shared/ipc.js'
import { HARVEST_CODE_TEXT } from '../shared/harvest.js'
import { createApi, type VoiceCordApi } from './api.js'
import { createHarvestClient, findSoundboardAnchor } from './anchor.js'
import { buildGraftButton, createGraft, refreshGraftButton, type GraftState } from './graft.js'
import { frameInfoOf, shouldMount } from './guard.js'
import { containKeyboard, escapeAction, hasOpenLayer } from './keyboard.js'
import { decideFab, FAB_REASON_TEXT, readVcSignal, type FabReason } from './presence.js'
import { createShell, SHELL_CSS, statusProblems, type Shell } from './shell.js'
import { probeDevices, probeSync, summarizeProbe } from './probe.js'
import { injectStyles } from './styles.js'

/**
 * Discord の renderer に載る preload。isolated world で動く。
 *
 * isolated world は DOM を共有するので（Chrome 拡張の content script と同じ）、
 * ここで作ったノードは本物の DOM ノードになる。一方で JavaScript の実行は
 * CSP の script-src の対象外なので、Discord の CSP を一切書き換えずに UI を出せる。
 *
 * M4.5 からの構成:
 *   - 採取役（payload/harvest.js）だけをメインワールドへ流し込む。読み取り専用で、
 *     webpack から音声パネルのボタンの CSS クラス名を引いて文字列で返すだけ
 *   - 純正サウンドボードボタンの隣に同じ見た目のボタンを接ぎ木する（graft.ts）
 *   - 押すと Discord のサウンドボードと同じ意匠のポップアウトが開く（UI バンドル）
 *   - 接ぎ木できない故障時だけ FAB を出す（presence.ts）
 */

declare global {
  // eslint-disable-next-line no-var
  var api: VoiceCordApi | undefined
}

const GRAFT_LABEL = 'VoiceCord'

const TIER_WARNING =
  'VoiceCord: サウンドボードのボタンを予備の方法で見つけています。Discord の次の更新でボタンが出なくなる可能性があります'

function whenBodyReady(doc: Document, fn: () => void): void {
  if (doc.body) {
    fn()
    return
  }
  doc.addEventListener('DOMContentLoaded', () => fn(), { once: true })
}

/**
 * 採取役をメインワールドへ流し込む。
 * webFrame.executeJavaScript はメインワールド（kMainWorldId）で実行される
 * （Electron v42.11.2 の electron_api_web_frame.cc で確認）。<script> を経由しないので
 * CSP の script-src に当たらない。Vencord が同じ経路を実 CSP 下で使っている。
 *
 * 失敗しても 2 段目以降のアンカー発見で動くので、ログだけ残して続ける。
 */
function injectHarvester(): string | null {
  const file = path.join(__dirname, 'harvest.js')
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (e) {
    console.error('[VoiceCord] 採取役が読めません', e)
    return '採取役のファイルを読めませんでした'
  }
  void webFrame.executeJavaScript(source).catch((e: unknown) => {
    console.error('[VoiceCord] 採取役の実行に失敗しました', e)
  })
  return null
}

function main(): void {
  const decision = shouldMount(frameInfoOf(window))
  if (!decision.mount) return

  const api = createApi(ipcRenderer)
  // isolated world の window なので、Discord のページからは見えない
  globalThis.api = api

  injectStyles(document, SHELL_CSS)

  // 結果を受ける口は採取役を流し込む前に張る（取りこぼさない）
  const harvest = createHarvestClient({
    doc: document,
    makeEvent: (type) => new CustomEvent(type),
    now: () => Date.now()
  })
  let harvestError: string | null = null
  try {
    harvestError = injectHarvester()
  } catch (e) {
    console.error('[VoiceCord] 採取役を流し込めませんでした', e)
    harvestError = '採取役を流し込めませんでした'
  }

  let shell: Shell | null = null
  let ui: UiController | null = null
  let uiError: string | null = null

  whenBodyReady(document, () => {
    const sh = createShell({ doc: document })
    shell = sh
    document.body.appendChild(sh.root)
    sh.settle()

    // UI は別バンドルにして、DOM が用意できてから初めて読み込む。
    // ここが落ちても FAB と状態表示は残す（パッチが当たっていることと、
    // 落ちた理由を出せる状態は保つ）。
    try {
      const mod = require(path.join(__dirname, 'ui.js')) as { mount: (c: HTMLElement) => UiController }
      ui = mod.mount(sh.body)
      injectStyles(document, ui.css)
    } catch (e) {
      console.error('[VoiceCord] UI のマウントに失敗しました', e)
      uiError = e instanceof Error ? e.message : String(e)
      ui = null
    }

    try {
      const base = probeSync()
      sh.root.dataset['vcProbe'] = summarizeProbe(base)
      void probeDevices(base).then((full) => {
        sh.root.dataset['vcProbe'] = summarizeProbe(full)
      })
    } catch (e) {
      sh.root.dataset['vcProbe'] = `probe failed: ${e instanceof Error ? e.message : String(e)}`
    }

    const escFor = (): ReturnType<typeof escapeAction> =>
      escapeAction({
        active: document.activeElement,
        root: sh.root,
        popoutOpen: ui?.isOpen() ?? false,
        diagOpen: sh.isOpen()
      })

    // Esc は封じ込めより先に登録する。封じ込めは stopImmediatePropagation なので、
    // 後から登録した Esc の処理はポップアウトの中では届かない。
    // ただし入れ子のレイヤー（音量の Popover やダイアログ）にフォーカスがあるときは
    // 手前だけを閉じるのが期待される動きなので、ここでは処理せず Radix に任せる
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return
        const action = escFor()
        if (action === 'close-popout') {
          e.stopImmediatePropagation()
          ui?.setOpen(false)
        } else if (action === 'close-diag') {
          e.stopImmediatePropagation()
          sh.close()
        }
      },
      { capture: true }
    )
    // 封じ込めは「#vc-root 内に開いたレイヤーがあるか」で判定する。ポップアウトの開閉だけで
    // 見ると、ポップアウトの外の LevelDialog を開いたときや VC を抜けてアンカーが消えたときに外れる
    containKeyboard(document, {
      root: sh.root,
      isOpen: () => hasOpenLayer(sh.portal) || sh.isOpen(),
      passThrough: (e) => (e as KeyboardEvent).code === 'Escape' && escFor() === 'pass'
    })

    // ---- 入口の出し分け ----
    let status: VoiceCordStatus | null = null
    let inVc = false
    let missingSince: number | null = null
    let graftState: GraftState = { tier: null, button: null, inserts: 0, tripped: false }
    /** 下の段で見つけた時点で受け取っていた採取結果の数。引き直し後もまだ下の段なら警告する */
    let lowTierSeenAt = -1
    let warnedTier = false
    const warnedFab = new Set<FabReason>()

    const wireButton = (b: HTMLElement): HTMLElement => {
      b.addEventListener('click', (e) => {
        // 純正の音声パネルのハンドラに届かせない
        e.preventDefault()
        e.stopPropagation()
        sh.hideTip()
        if (!ui) {
          sh.toggle()
          return
        }
        ui.setAnchor(b)
        ui.toggle()
      })
      b.addEventListener('pointerenter', () => {
        if (!ui?.isOpen()) sh.showTip(b, GRAFT_LABEL)
      })
      b.addEventListener('pointerleave', () => sh.hideTip())
      b.addEventListener('focus', () => {
        if (!ui?.isOpen()) sh.showTip(b, GRAFT_LABEL)
      })
      b.addEventListener('blur', () => sh.hideTip())
      return b
    }

    // 採取の状況は固定の文言だけで出す（メインワールドから届いた文字列は画面に出さない）
    const harvestSummary = (): string => {
      if (harvestError) return harvestError
      const last = harvest.last()
      if (last === null) return '結果待ち'
      if (last.classes) return last.source === 'vencord' ? '取得済み（Vencord 経由）' : '取得済み（webpack）'
      return `未取得（${HARVEST_CODE_TEXT[last.code ?? 'unknown']}）`
    }

    const update = (): void => {
      // 引き直しの要求は非同期で投げられるので、この処理の途中で状態が書き換わることはない
      if (graftState.tier !== null && graftState.tier > 1) {
        harvest.request()
        if (lowTierSeenAt < 0) lowTierSeenAt = harvest.results()
      } else if (graftState.tier === 1) {
        lowTierSeenAt = -1
      }
      // 状態は要求の後で読む
      const s = graftState
      const now = Date.now()

      if (s.button !== null || !inVc) missingSince = null
      else if (missingSince === null) missingSince = now

      const d = decideFab({
        uiMounted: ui !== null,
        grafted: s.button !== null,
        tripped: s.tripped,
        inVc,
        missingSince,
        now,
        engine: status?.engine ?? null,
        problems: status !== null && statusProblems(status).length > 0
      })

      const reasonText = d.fab ? FAB_REASON_TEXT[d.reason] : null
      sh.setFab(d.fab, reasonText)
      if (d.fab) {
        if (ui) {
          if (s.button === null) ui.setAnchor(sh.fab)
          // 故障の通知は理由ごとに 1 回だけ。エンジンの不調はポップアウト内に常に出るので通知しない
          if ((d.reason === 'anchor-missing' || d.reason === 'reinsert-storm') && !warnedFab.has(d.reason)) {
            warnedFab.add(d.reason)
            ui.notify(`VoiceCord: ${FAB_REASON_TEXT[d.reason]}`)
          }
        }
      } else if (ui) {
        if (s.button !== null) ui.setAnchor(s.button)
        // 純正ボタンが消えた（VC を抜けた・DM を開いた）ら、開いていたポップアウトも閉じる。
        // ポップアウトから開いたダイアログは store が持っているので残り、封じ込めも続く
        else ui.setAnchor(null)
      }

      if (
        ui &&
        !warnedTier &&
        s.tier !== null &&
        s.tier > 1 &&
        lowTierSeenAt >= 0 &&
        harvest.results() > lowTierSeenAt
      ) {
        warnedTier = true
        ui.notify(TIER_WARNING)
      }

      ui?.setAnchorInfo({
        mode: s.button !== null ? 'graft' : d.fab ? 'fab' : 'none',
        tier: s.tier,
        inserts: s.inserts,
        tripped: s.tripped,
        harvest: harvestSummary(),
        fabReason: reasonText
      })
    }

    sh.onFabClick(() => {
      if (!ui) {
        sh.toggle()
        return
      }
      ui.setAnchor(sh.fab)
      ui.toggle()
    })

    ui?.onOpenChange((open) => {
      graftState.button?.setAttribute('aria-expanded', String(open))
      if (open) sh.hideTip()
    })

    const graft = createGraft({
      doc: document,
      ignoreWithin: sh.root,
      find: () =>
        findSoundboardAnchor(document, { classes: harvest.classes(), ignoreWithin: sh.root, inVc }),
      build: (anchor) => wireButton(buildGraftButton(document, anchor, GRAFT_LABEL)),
      refresh: refreshGraftButton,
      onChange: (s) => {
        graftState = s
        update()
      },
      now: () => Date.now()
    })

    // 新しいクラス名が届いたら 1 段目で探し直す（通知は anchor.ts 側で間引いてある）
    harvest.onResult(() => {
      graft.sync(true)
      update()
    })

    // 「VC に居るのに純正ボタンが無い」の猶予切れを拾う。見つかっている間は何もしない
    setInterval(() => {
      if (inVc && graftState.button === null) update()
    }, 1000)

    graft.start()

    // UI のマウントに失敗していたら、その理由も状態に混ぜて出す
    const applyStatus = (s: VoiceCordStatus): void => {
      const merged =
        uiError === null ? s : { ...s, degraded: [...s.degraded, { name: 'ui', error: uiError }] }
      status = merged
      if (merged.engine !== 'attached') inVc = false
      sh.setStatus(merged)
      ui?.setStatus(merged)
      update()
    }
    api.onEvent((ev) => {
      if (ev.ev === 'status') {
        applyStatus(ev.status)
        return
      }
      if (ev.ev !== 'engine') return
      const signal = readVcSignal(ev.payload)
      if (signal === null) return
      const next = signal === 'in'
      if (next === inVc) return
      inVc = next
      // VC に入ったら 4 段目も含めて探し直す（VC 外では 4 段目を試していない）
      if (inVc) graft.sync(true)
      update()
    })
    api.subscribe().then(applyStatus, (e: unknown) => {
      applyStatus({
        engine: 'failed',
        attachedPid: null,
        enginePid: null,
        sampleRate: null,
        frameSamples: null,
        discordBuild: 'unknown',
        discordVersion: 'unknown',
        lastError: `main プロセスと通信できません: ${e instanceof Error ? e.message : String(e)}`,
        degraded: []
      })
    })
    update()
  })
}

try {
  main()
} catch (e) {
  console.error('[VoiceCord] preload の初期化に失敗しました。Discord は通常どおり続行します', e)
}
