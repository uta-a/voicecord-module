import { ipcRenderer } from 'electron'
import type { VoiceCordStatus } from '../shared/ipc.js'
import { createApi, type VoiceCordApi } from './api.js'
import { frameInfoOf, shouldMount } from './guard.js'
import { containKeyboard, DEFAULT_HOTKEY, matchesHotkey } from './keyboard.js'
import { createShell, SHELL_CSS, type Shell } from './shell.js'
import { probeDevices, probeSync, summarizeProbe } from './probe.js'
import { injectStyles } from './styles.js'

/**
 * Discord の renderer に載る preload。isolated world で動く。
 *
 * isolated world は DOM を共有するので（Chrome 拡張の content script と同じ）、
 * ここで作ったノードは本物の DOM ノードになる。一方で JavaScript の実行は
 * CSP の script-src の対象外なので、Discord の CSP を一切書き換えずに UI を出せる。
 * これは Vencord との共存要件でもある（Vencord は onHeadersReceived を潰すので、
 * そもそも後から CSP を書き換えることができない）。
 */

declare global {
  // eslint-disable-next-line no-var
  var api: VoiceCordApi | undefined
}

function whenBodyReady(doc: Document, fn: () => void): void {
  if (doc.body) {
    fn()
    return
  }
  doc.addEventListener('DOMContentLoaded', () => fn(), { once: true })
}

function main(): void {
  const decision = shouldMount(frameInfoOf(window))
  if (!decision.mount) return

  const api = createApi(ipcRenderer)
  // isolated world の window なので、Discord のページからは見えない
  globalThis.api = api

  injectStyles(document, SHELL_CSS)

  let shell: Shell | null = null

  whenBodyReady(document, () => {
    shell = createShell({ doc: document })
    document.body.appendChild(shell.root)

    // isolated world で Web Audio とデバイス列挙が使えるかの自己診断。
    // 結果を data 属性に書いておくと、メインワールドや CDP から DOM 経由で
    // 読めるので、実機での確認を人の目に頼らずに済む。
    try {
      const base = probeSync()
      shell.root.dataset['vcProbe'] = summarizeProbe(base)
      void probeDevices(base).then((full) => {
        if (shell) shell.root.dataset['vcProbe'] = summarizeProbe(full)
      })
    } catch (e) {
      shell.root.dataset['vcProbe'] = `probe failed: ${e instanceof Error ? e.message : String(e)}`
    }

    // パネル内のテキスト入力中に Discord のショートカットを暴発させない
    containKeyboard(document, {
      root: shell.root,
      isOpen: () => shell?.isOpen() ?? false
    })

    document.addEventListener(
      'keydown',
      (e) => {
        if (matchesHotkey(e, DEFAULT_HOTKEY)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          shell?.toggle()
          return
        }
        if (e.code === 'Escape' && shell?.isOpen()) {
          e.stopImmediatePropagation()
          shell.close()
        }
      },
      { capture: true }
    )

    const apply = (s: VoiceCordStatus): void => shell?.setStatus(s)
    api.onEvent((ev) => {
      if (ev.ev === 'status') apply(ev.status)
    })
    // 購読開始と同時に現在の状態を受け取る。
    // 失敗しても FAB は出したままにする（パッチが当たっていることは示せる）
    api.subscribe().then(apply, (e: unknown) => {
      shell?.setStatus({
        engine: 'failed',
        attachedPid: null,
        discordBuild: 'unknown',
        discordVersion: 'unknown',
        lastError: `main プロセスと通信できません: ${e instanceof Error ? e.message : String(e)}`,
        degraded: []
      })
    })
  })
}

try {
  main()
} catch (e) {
  console.error('[VoiceCord] preload の初期化に失敗しました。Discord は通常どおり続行します', e)
}
