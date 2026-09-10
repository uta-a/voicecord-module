import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolvePayloadDir } from '../src/manager/payloadDir.js'

const win = path.win32.join
const REPO = 'C:\repo'

describe('resolvePayloadDir', () => {
  it('開発時は dist-manager の 1 つ上を見る', () => {
    // dist-manager には CommonJS 宣言用の package.json があるため、
    // app.getAppPath() はそこを返してしまう。__dirname 起点で解決する
    const got = resolvePayloadDir(
      { isPackaged: false, resourcesPath: '(未使用)', mainDir: win(REPO, 'dist-manager') },
      win
    )
    expect(path.win32.normalize(got)).toBe(win(REPO, 'payload'))
  })

  it('dist-manager/payload を見に行かない（実機で踏んだ回帰）', () => {
    const got = resolvePayloadDir(
      { isPackaged: false, resourcesPath: '', mainDir: win(REPO, 'dist-manager') },
      win
    )
    expect(path.win32.normalize(got)).not.toContain('dist-manager')
  })

  it('配布時は resources/payload', () => {
    const got = resolvePayloadDir(
      { isPackaged: true, resourcesPath: win('C:\app', 'resources'), mainDir: '(未使用)' },
      win
    )
    expect(got).toBe(win('C:\app', 'resources', 'payload'))
  })
})
