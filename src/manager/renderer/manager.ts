import type { InstallRow, OpResult } from '../service.js'

/**
 * マネージャの画面。
 *
 * 判定はすべて main 側で app.asar の実物を読んで行っている。ここは表示だけ。
 */

interface Vcm {
  list(): Promise<InstallRow[]>
  apply(resourcesDir: string, extraChain: string[]): Promise<OpResult>
  unpatch(resourcesDir: string, mode: 'full' | 'voicecordOnly'): Promise<OpResult>
  openFolder(dir: string): Promise<void>
  restoreDoc(): Promise<void>
}

declare const vcm: Vcm

const STATE_LABEL: Record<string, string> = {
  clean: '未パッチ',
  voicecord: 'VoiceCord 有効',
  otherMod: '他の mod のみ',
  broken: '異常'
}

const listEl = document.getElementById('list') as HTMLElement
const msgEl = document.getElementById('msg') as HTMLElement

function say(result: OpResult | null): void {
  if (!result) {
    msgEl.textContent = ''
    msgEl.className = ''
    return
  }
  msgEl.textContent = result.message
  msgEl.className = result.ok ? 'ok' : 'ng'
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderRow(row: InstallRow, refresh: () => void): HTMLElement {
  const box = el('div', 'row')

  const head = el('div', 'head')
  head.append(
    el('span', 'name', row.label),
    el('span', 'ver', row.version),
    el('span', 'spacer'),
    el('span', `badge b-${row.state}`, STATE_LABEL[row.state] ?? row.state)
  )
  box.append(head)

  if (row.detail) box.append(el('div', 'detail', row.detail))
  if (row.lastPatcherRunAt) {
    box.append(el('div', 'detail', `mod が最後に動いたのは ${row.lastPatcherRunAt}`))
  }

  // パッチが外れると音が無言で鳴らなくなる。気付ける形で前に出す
  if (row.staleVersion) {
    box.append(el('div', 'warn', 'Discord が更新されています。再適用が必要です。'))
  }
  if (row.state === 'broken') {
    box.append(el('div', 'warn', 'この状態では操作しません。復旧手順を確認してください。'))
  }
  if (row.running) {
    box.append(el('div', 'warn', `${row.label} が起動しています。終了してから操作してください。`))
  }

  // Canary での連鎖テスト用。既にそのインストールに入っている mod は
  // 自動で引き継がれるので、ここは「新しく足す」ときだけ使う
  const chain = el('div', 'chain')
  const chainLabel = el('label', undefined, '連鎖に足す patcher: ')
  const chainInput = document.createElement('input')
  chainInput.type = 'text'
  chainInput.placeholder = '（任意）C:\\Users\\...\\Vencord\\dist\\patcher.js'
  chainLabel.append(chainInput)
  chain.append(chainLabel)
  box.append(chain)

  const actions = el('div', 'actions')
  const busy = row.running || row.state === 'broken'

  const applyBtn = document.createElement('button')
  applyBtn.className = 'primary'
  applyBtn.textContent = row.active ? '再適用' : '適用'
  applyBtn.disabled = busy
  applyBtn.addEventListener('click', () => {
    void run(() => {
      const extra = chainInput.value.trim()
      return vcm.apply(row.resourcesDir, extra ? [extra] : [])
    }, refresh)
  })
  actions.append(applyBtn)

  if (row.state === 'voicecord') {
    const onlyBtn = document.createElement('button')
    onlyBtn.textContent = 'VoiceCord だけ外す'
    onlyBtn.disabled = busy
    onlyBtn.addEventListener('click', () => {
      void run(() => vcm.unpatch(row.resourcesDir, 'voicecordOnly'), refresh)
    })
    actions.append(onlyBtn)
  }

  if (row.state === 'voicecord' || row.state === 'otherMod') {
    const fullBtn = document.createElement('button')
    fullBtn.className = 'danger'
    fullBtn.textContent = '素の Discord に戻す'
    fullBtn.disabled = busy
    fullBtn.addEventListener('click', () => {
      // 他 mod も外れるので、押す前に伝える
      const ok = confirm(
        `${row.label} を素の状態に戻します。\nVencord など他の mod も同時に外れます。続けますか?`
      )
      if (!ok) return
      void run(() => vcm.unpatch(row.resourcesDir, 'full'), refresh)
    })
    actions.append(fullBtn)
  }

  const openBtn = document.createElement('button')
  openBtn.textContent = 'フォルダを開く'
  openBtn.addEventListener('click', () => void vcm.openFolder(row.resourcesDir))
  actions.append(openBtn)

  box.append(actions)
  return box
}

async function run(op: () => Promise<OpResult>, refresh: () => void): Promise<void> {
  say(null)
  try {
    say(await op())
  } catch (e) {
    say({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
  refresh()
}

async function refresh(): Promise<void> {
  try {
    const rows = await vcm.list()
    listEl.replaceChildren()
    if (rows.length === 0) {
      listEl.append(el('div', 'row', 'Discord が見つかりませんでした。'))
      return
    }
    for (const row of rows) listEl.append(renderRow(row, () => void refresh()))
  } catch (e) {
    listEl.replaceChildren()
    listEl.append(el('div', 'warn', `一覧を取得できません: ${e instanceof Error ? e.message : String(e)}`))
  }
}

document.getElementById('reload')?.addEventListener('click', () => void refresh())
document.getElementById('restore')?.addEventListener('click', () => void vcm.restoreDoc())

void refresh()
