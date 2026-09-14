import { describe, expect, it, vi } from 'vitest'
import { runSubsystems, summarize, type SubsystemLog } from '../src/patcher/subsystems.js'
import { PRELOAD_ID, registerPreload, type SessionLike } from '../src/patcher/preloadReg.js'
import {
  registerIpc,
  Subscribers,
  type IpcDeps,
  type IpcMainLike,
  type WebContentsLike
} from '../src/patcher/ipc.js'
import { CH, INVOKE_CHANNELS } from '../src/shared/ipc.js'
import type { VoiceCordStatus } from '../src/shared/ipc.js'
import { defaultConfig } from '../src/shared/config.js'
import type { AppConfig, LoadedConfig, SoundItem } from '../src/shared/types.js'

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

const CONFIG: AppConfig = defaultConfig('C:/sounds')

const STATUS: VoiceCordStatus = {
  engine: 'starting',
  attachedPid: null,
  enginePid: null,
  sampleRate: null,
  frameSamples: null,
  discordBuild: 'canary',
  discordVersion: '1.0.1099',
  lastError: null,
  degraded: []
}

/** registerIpc の依存。既定は「全部成功する」。個別のテストで差し替える */
function deps(over: Partial<IpcDeps> = {}): IpcDeps & {
  saved: Array<Partial<AppConfig>>
  engineCalls: Array<{ ch: string; args: unknown[] }>
  restarts: unknown[]
} {
  const saved: Array<Partial<AppConfig>> = []
  const engineCalls: Array<{ ch: string; args: unknown[] }> = []
  const restarts: unknown[] = []
  const base: IpcDeps = {
    subscribers: new Subscribers(),
    getStatus: () => STATUS,
    config: {
      get: () => CONFIG,
      save: (partial) => {
        saved.push(partial)
        return { ok: true }
      },
      loadWarning: null
    },
    sounds: {
      scan: (folder) => [{ id: folder, name: `${folder}.wav`, path: folder, fp: '1_2', kind: 'file' }],
      read: () => new ArrayBuffer(8)
    },
    chooseFolder: async () => 'C:/picked',
    engine: {
      request: async (ch, args) => {
        engineCalls.push({ ch, args })
        return `res:${ch}`
      },
      restart: () => void restarts.push(1)
    }
  }
  const merged = { ...base, ...over } as IpcDeps
  return Object.assign(merged, { saved, engineCalls, restarts }) as never
}

describe('registerIpc', () => {
  it('全チャンネルを登録する', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, deps())
    // event は push 専用なので handle しない
    expect(ipc.handlers.has(CH.event)).toBe(false)
    for (const ch of INVOKE_CHANNELS) expect(ipc.handlers.has(ch)).toBe(true)
  })

  it('二重登録で落ちない（開発中の読み直しに耐える）', () => {
    const ipc = fakeIpcMain()
    const d = deps()
    registerIpc(ipc, d)
    expect(() => registerIpc(ipc, d)).not.toThrow()
  })

  it('subscribe は購読者に足して現在の状態を返す', () => {
    const ipc = fakeIpcMain()
    const d = deps()
    registerIpc(ipc, d)
    const got = ipc.handlers.get(CH.subscribe)!({ sender: fakeWc() })
    expect(got).toEqual(STATUS)
    expect(d.subscribers.size).toBe(1)
  })

  it('getConfig は読み込み時の警告を一緒に返す（無言で既定値にしない）', () => {
    const ipc = fakeIpcMain()
    const d = deps()
    ;(d.config as { loadWarning: string | null }).loadWarning = '以前の設定を引き継ぎました'
    registerIpc(ipc, d)
    const got = ipc.handlers.get(CH.getConfig)!({ sender: fakeWc() }) as LoadedConfig
    expect(got.folder).toBe(CONFIG.folder)
    expect(got.loadWarning).toBe('以前の設定を引き継ぎました')
  })

  it('saveConfig は部分更新を渡す', () => {
    const ipc = fakeIpcMain()
    const d = deps()
    registerIpc(ipc, d)
    ipc.handlers.get(CH.saveConfig)!({ sender: fakeWc() }, { master: 2 })
    expect(d.saved).toEqual([{ master: 2 }])
  })

  it('saveConfig は形が違えば断る', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, deps())
    expect(() => ipc.handlers.get(CH.saveConfig)!({ sender: fakeWc() }, [1])).toThrow(/形が想定/)
    expect(() => ipc.handlers.get(CH.saveConfig)!({ sender: fakeWc() }, null)).toThrow(/形が想定/)
  })

  it('保存に失敗したら黙らせない（次の起動で消えることを伝える）', () => {
    const ipc = fakeIpcMain()
    registerIpc(
      ipc,
      deps({
        config: { get: () => CONFIG, save: () => ({ ok: false, error: 'EACCES' }), loadWarning: null }
      })
    )
    expect(() => ipc.handlers.get(CH.saveConfig)!({ sender: fakeWc() }, { master: 2 })).toThrow(
      /保存できませんでした: EACCES/
    )
  })

  it('scanFolder は引数が無ければ設定中のフォルダを見る', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, deps())
    const withArg = ipc.handlers.get(CH.scanFolder)!({ sender: fakeWc() }, 'C:/other')
    const noArg = ipc.handlers.get(CH.scanFolder)!({ sender: fakeWc() })
    expect((withArg as SoundItem[])[0]?.id).toBe('C:/other')
    expect((noArg as SoundItem[])[0]?.id).toBe(CONFIG.folder)
  })

  it('readSoundFile は設定中のフォルダを基準に検証させる', () => {
    const ipc = fakeIpcMain()
    const seen: Array<[string, string]> = []
    registerIpc(
      ipc,
      deps({
        sounds: {
          scan: () => [],
          read: (folder, requested) => {
            seen.push([folder, requested])
            return new ArrayBuffer(4)
          }
        }
      })
    )
    ipc.handlers.get(CH.readSoundFile)!({ sender: fakeWc() }, 'a.wav')
    expect(seen).toEqual([[CONFIG.folder, 'a.wav']])
  })

  it('readSoundFile は文字列でない指定を断る', () => {
    const ipc = fakeIpcMain()
    registerIpc(ipc, deps())
    expect(() => ipc.handlers.get(CH.readSoundFile)!({ sender: fakeWc() }, 42)).toThrow(
      /パスが指定されていません/
    )
  })

  it('エンジン担当のチャンネルはそのまま転送する', async () => {
    const ipc = fakeIpcMain()
    const d = deps()
    registerIpc(ipc, d)
    await ipc.handlers.get(CH.play)!({ sender: fakeWc() }, { srcId: 'a' })
    await ipc.handlers.get(CH.stopAll)!({ sender: fakeWc() })
    expect(d.engineCalls).toEqual([
      { ch: CH.play, args: [{ srcId: 'a' }] },
      { ch: CH.stopAll, args: [] }
    ])
  })

  it('reattach は転送ではなくエンジンの起こし直し', () => {
    const ipc = fakeIpcMain()
    const d = deps()
    registerIpc(ipc, d)
    expect(ipc.handlers.get(CH.reattach)!({ sender: fakeWc() })).toEqual(STATUS)
    expect(d.restarts).toHaveLength(1)
    expect(d.engineCalls).toEqual([])
  })

  it('エンジンが死んでいても設定は読める（音は鳴らないが理由は読める）', () => {
    const ipc = fakeIpcMain()
    registerIpc(
      ipc,
      deps({
        engine: {
          request: () => Promise.reject(new Error('エンジンが動いていません')),
          restart: () => {
            throw new Error('エンジンが起動していません')
          }
        }
      })
    )
    expect(() => ipc.handlers.get(CH.getConfig)!({ sender: fakeWc() })).not.toThrow()
    expect(() => ipc.handlers.get(CH.reattach)!({ sender: fakeWc() })).toThrow(/起動していません/)
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
