import { describe, expect, it, vi } from 'vitest'
import { runSubsystems, summarize, type SubsystemLog } from '../src/patcher/subsystems.js'
import { PRELOAD_ID, registerPreload, type SessionLike } from '../src/patcher/preloadReg.js'
import {
  makeNotImplemented,
  registerIpc,
  Subscribers,
  type IpcMainLike,
  type WebContentsLike
} from '../src/patcher/ipc.js'
import { CH } from '../src/shared/ipc.js'
import type { VoiceCordStatus } from '../src/shared/ipc.js'

const quietLog = (): SubsystemLog => ({ info: vi.fn(), error: vi.fn() })

describe('runSubsystems', () => {
  it('1 つ失敗しても残りは動く（Discord を巻き添えにしない）', () => {
    const ran: string[] = []
    const log = quietLog()
    const out = runSubsystems(
      [
        { name: 'config', run: () => void ran.push('config') },
        {
          name: 'engine',
          run: () => {
            throw new Error('frida のロードに失敗')
          }
        },
        { name: 'preload', run: () => void ran.push('preload') }
      ],
      log
    )
    // engine が落ちても preload は登録される ＝ FAB は出る
    expect(ran).toEqual(['config', 'preload'])
    expect(out.map((o) => o.ok)).toEqual([true, false, true])
    expect(out[1]!.error).toContain('frida')
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('決して throw しない（文字列を投げられても）', () => {
    const out = runSubsystems([{ name: 'x', run: () => { throw 'plain string' } }], quietLog())
    expect(out[0]!.ok).toBe(false)
    expect(out[0]!.error).toBe('plain string')
  })

  it('全部成功したら degraded は空', () => {
    const out = runSubsystems([{ name: 'a', run: () => {} }], quietLog())
    expect(summarize(out)).toEqual({ ok: true, failures: [] })
  })

  it('失敗した名前と理由を要約に出す', () => {
    const out = runSubsystems(
      [{ name: 'engine', run: () => { throw new Error('boom') } }],
      quietLog()
    )
    expect(summarize(out)).toEqual({ ok: false, failures: [{ name: 'engine', error: 'boom' }] })
  })
})

describe('registerPreload', () => {
  const FILE = 'C:/VoiceCord/dist/preload.js'

  it('registerPreloadScript があればそれを使う', () => {
    const calls: unknown[] = []
    const ses: SessionLike = {
      getPreloadScripts: () => [],
      registerPreloadScript: (s) => {
        calls.push(s)
        return 'id'
      }
    }
    expect(registerPreload(ses, FILE)).toEqual({ ok: true, via: 'registerPreloadScript' })
    expect(calls[0]).toEqual({ id: PRELOAD_ID, type: 'frame', filePath: FILE })
  })

  it('既に登録済みなら二重登録しない', () => {
    const register = vi.fn(() => 'id')
    const ses: SessionLike = {
      getPreloadScripts: () => [{ id: PRELOAD_ID, filePath: FILE }],
      registerPreloadScript: register
    }
    expect(registerPreload(ses, FILE)).toEqual({ ok: true, via: 'already' })
    expect(register).not.toHaveBeenCalled()
  })

  it('registerPreloadScript が無ければ setPreloads にフォールバックする', () => {
    let preloads = ['C:/Discord/mainScreenPreload.js']
    const ses: SessionLike = {
      getPreloads: () => preloads,
      setPreloads: (p) => {
        preloads = p
      }
    }
    expect(registerPreload(ses, FILE)).toEqual({ ok: true, via: 'setPreloads' })
    // Discord 本来の preload を消さずに足す
    expect(preloads).toEqual(['C:/Discord/mainScreenPreload.js', FILE])
  })

  it('フォールバックでも二重登録しない', () => {
    const ses: SessionLike = { getPreloads: () => [FILE], setPreloads: vi.fn() }
    expect(registerPreload(ses, FILE)).toEqual({ ok: true, via: 'already' })
    expect(ses.setPreloads).not.toHaveBeenCalled()
  })

  it('API が無ければ ok:false を返す（throw しない）', () => {
    expect(registerPreload({}, FILE)).toEqual({
      ok: false,
      error: 'このセッションには preload を登録する API がありません'
    })
  })

  it('登録が throw しても飲み込む（UI が出ないだけで Discord は動く）', () => {
    const ses: SessionLike = {
      getPreloadScripts: () => [],
      registerPreloadScript: () => {
        throw new Error('nope')
      }
    }
    const r = registerPreload(ses, FILE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('nope')
  })
})

function fakeWc(): WebContentsLike & { sent: unknown[][]; destroy: () => void } {
  let destroyed = false
  const listeners: Array<() => void> = []
  const sent: unknown[][] = []
  return {
    sent,
    isDestroyed: () => destroyed,
    send: (channel, ...args) => {
      sent.push([channel, ...args])
    },
    once: (_e, l) => {
      listeners.push(l)
    },
    destroy: () => {
      destroyed = true
      for (const l of listeners) l()
    }
  }
}

describe('Subscribers', () => {
  it('複数の renderer に配信する', () => {
    const subs = new Subscribers()
    const a = fakeWc()
    const b = fakeWc()
    subs.add(a)
    subs.add(b)
    subs.broadcast({ ev: 'log', level: 'info', message: 'hi' })
    expect(a.sent[0]![0]).toBe(CH.event)
    expect(b.sent).toHaveLength(1)
  })

  it('同じ相手を二重に登録しない', () => {
    const subs = new Subscribers()
    const a = fakeWc()
    subs.add(a)
    subs.add(a)
    expect(subs.size).toBe(1)
  })

  it('破棄された相手は外す', () => {
    const subs = new Subscribers()
    const a = fakeWc()
    subs.add(a)
    a.destroy()
    expect(subs.size).toBe(0)
  })

  it('送信で例外が出ても他への配信を止めない', () => {
    const subs = new Subscribers()
    const bad = fakeWc()
    bad.send = () => {
      throw new Error('gone')
    }
    const good = fakeWc()
    subs.add(bad)
    subs.add(good)
    subs.broadcast({ ev: 'log', level: 'info', message: 'x' })
    expect(good.sent).toHaveLength(1)
    expect(subs.size).toBe(1)
  })
})

function fakeIpcMain(): IpcMainLike & { handlers: Map<string, Function>; removed: string[] } {
  const handlers = new Map<string, Function>()
  const removed: string[] = []
  return {
    handlers,
    removed,
    handle: (ch, fn) => {
      if (handlers.has(ch)) throw new Error(`二重登録: ${ch}`)
      handlers.set(ch, fn)
    },
    removeHandler: (ch) => {
      removed.push(ch)
      handlers.delete(ch)
    }
  }
}

const STATUS: VoiceCordStatus = {
  engine: 'starting',
  attachedPid: null,
  discordBuild: 'canary',
  discordVersion: '1.0.1099',
  lastError: null,
  degraded: []
}

describe('registerIpc', () => {
  it('全チャンネルを登録する', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, {
      subscribers: new Subscribers(),
      getStatus: () => STATUS,
      notImplemented: makeNotImplemented('M2')
    })
    // event は push 専用なので handle しない
    expect(ipc.handlers.has(CH.event)).toBe(false)
    expect(ipc.handlers.has(CH.getStatus)).toBe(true)
    expect(ipc.handlers.has(CH.subscribe)).toBe(true)
    expect(ipc.handlers.has(CH.play)).toBe(true)
  })

  it('二重登録で落ちない（開発中の読み直しに耐える）', () => {
    const ipc = fakeIpcMain()
    const deps = {
      subscribers: new Subscribers(),
      getStatus: () => STATUS,
      notImplemented: makeNotImplemented('M2')
    }
    registerIpc(ipc, deps)
    expect(() => registerIpc(ipc, deps)).not.toThrow()
  })

  it('subscribe は購読者に足して現在の状態を返す', () => {
    const ipc = fakeIpcMain()
    const subs = new Subscribers()
    registerIpc(ipc, { subscribers: subs, getStatus: () => STATUS, notImplemented: makeNotImplemented('M2') })
    const wc = fakeWc()
    const got = ipc.handlers.get(CH.subscribe)!({ sender: wc })
    expect(got).toEqual(STATUS)
    expect(subs.size).toBe(1)
  })

  it('未実装チャンネルは無言で undefined を返さず、理由つきで断る', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, {
      subscribers: new Subscribers(),
      getStatus: () => STATUS,
      notImplemented: makeNotImplemented('M2')
    })
    expect(() => ipc.handlers.get(CH.play)!({ sender: fakeWc() })).toThrow(/M2 で実装予定/)
  })
})

describe('locateInstall / guessBranch', () => {
  it('shim の位置から resources とバージョンを割り出す', async () => {
    const { locateInstall, guessBranch } = await import('../src/patcher/locate.js')
    // require.main.path は <resources>/app.asar（ファイル名ではなくディレクトリ）
    const got = locateInstall('C:/Users/u/AppData/Local/DiscordCanary/app-1.0.1099/resources/app.asar')
    expect(got).toEqual({
      resourcesDir: 'C:/Users/u/AppData/Local/DiscordCanary/app-1.0.1099/resources',
      version: '1.0.1099'
    })
    expect(guessBranch(got!.resourcesDir)).toBe('canary')
  })

  it('想定外の配置なら null（推測で書き込まない）', async () => {
    const { locateInstall } = await import('../src/patcher/locate.js')
    expect(locateInstall(undefined)).toBeNull()
    expect(locateInstall('C:/somewhere/else/app.asar')).toBeNull()
    expect(locateInstall('C:/x/app-/resources/app.asar')).toBeNull()
  })

  it('各ブランチを見分ける', async () => {
    const { guessBranch } = await import('../src/patcher/locate.js')
    const at = (dir: string): string => `C:/Users/u/AppData/Local/${dir}/app-1.0.1/resources`
    expect(guessBranch(at('Discord'))).toBe('stable')
    expect(guessBranch(at('DiscordPTB'))).toBe('ptb')
    expect(guessBranch(at('DiscordCanary'))).toBe('canary')
    expect(guessBranch(at('DiscordDevelopment'))).toBe('development')
  })
})
