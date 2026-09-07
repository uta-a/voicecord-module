/**
 * Discord が起動しているかどうか。
 *
 * 起動中に app.asar を差し替えるとファイルがロックされていて失敗し、
 * 中途半端な状態になりうる。適用の前に必ず確かめる。
 *
 * ブランチごとに実行ファイル名が違う（Discord.exe / DiscordCanary.exe / ...）ので、
 * イメージ名で見れば十分に区別できる。同じブランチの別バージョンが同時に走ることは
 * ないため、実行ファイルのパスまで見る必要はない。
 *
 * 強制終了はしない。ユーザーに終了してもらう。
 */

/** tasklist の出力を返す関数を注入する（テストのため） */
export type ProcessLister = (imageName: string) => string

/**
 * tasklist の CSV 出力から、そのイメージ名のプロセスが居るかを判定する。
 *
 * 一致するものが無いとき tasklist は
 * 「情報: 指定された条件に一致するタスクは実行されていません。」のような
 * 1 行を返す（英語環境では INFO: No tasks are running ...）。CSV 行かどうかで
 * 見分けるのでロケールに依存しない。
 */
export function parseTasklist(output: string, imageName: string): number[] {
  const pids: number[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('"')) continue
    const cells = trimmed.split('","').map((c) => c.replace(/^"|"$/g, ''))
    const name = cells[0]
    const pid = Number(cells[1])
    if (name === undefined || !Number.isInteger(pid)) continue
    if (name.toLowerCase() !== imageName.toLowerCase()) continue
    pids.push(pid)
  }
  return pids
}

export interface RunningCheck {
  running: boolean
  pids: number[]
}

export function isRunning(list: ProcessLister, imageName: string): RunningCheck {
  let output: string
  try {
    output = list(imageName)
  } catch {
    // 判定できないときは「起動している」と見なす。
    // 分からないまま差し替えに進むより、止めて理由を出すほうが安全。
    return { running: true, pids: [] }
  }
  const pids = parseTasklist(output, imageName)
  return { running: pids.length > 0, pids }
}

/** 既定の実装。tasklist はロケールに関係なく CSV を吐く */
export function tasklistCommand(imageName: string): string[] {
  return ['tasklist', '/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']
}
