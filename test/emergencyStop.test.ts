import { describe, expect, it, vi } from 'vitest'
import {
  EMERGENCY_STOP_ACCELERATOR,
  registerEmergencyStop,
  type GlobalShortcutLike
} from '../src/patcher/emergencyStop.js'

/**
 * 緊急停止ホットキー。
 *
 * マイクが開きっぱなしになったときの最後の脱出口なので、「登録できていないのに
 * 効くと思わせる」のが一番まずい。失敗は必ず理由つきで返す。
 */

function fakeShortcut(accept: boolean): GlobalShortcutLike & { fire: () => void; accelerator: string | null } {
  let cb: (() => void) | null = null
  const gs = {
    accelerator: null as string | null,
    register: (acc: string, fn: () => void) => {
      gs.accelerator = acc
      if (accept) cb = fn
      return accept
    },
    unregister: () => {},
    fire: () => cb?.()
  }
  return gs
}

describe('registerEmergencyStop', () => {
  it('既定は Ctrl+Alt+Shift+X で登録し、押されたら停止処理を呼ぶ', () => {
    const gs = fakeShortcut(true)
    const onStop = vi.fn()
    expect(registerEmergencyStop(gs, onStop)).toEqual({ ok: true })
    expect(gs.accelerator).toBe(EMERGENCY_STOP_ACCELERATOR)
    gs.fire()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('他のアプリに取られていたら理由を返す', () => {
    const r = registerEmergencyStop(fakeShortcut(false), () => {})
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('他のアプリ')
  })

  it('登録そのものが投げても Discord を巻き込まず理由を返す', () => {
    const gs: GlobalShortcutLike = {
      register: () => {
        throw new Error('app is not ready')
      },
      unregister: () => {}
    }
    const r = registerEmergencyStop(gs, () => {})
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('app is not ready')
  })

  it('停止処理が投げても例外を外へ漏らさない', () => {
    const gs = fakeShortcut(true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerEmergencyStop(gs, () => {
      throw new Error('engine gone')
    })
    expect(() => gs.fire()).not.toThrow()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
