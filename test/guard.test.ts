import { describe, expect, it } from 'vitest'
import { isDiscordHost, shouldMount, type FrameInfo } from '../src/preload/guard.js'

const base: FrameInfo = {
  protocol: 'https:',
  hostname: 'discord.com',
  pathname: '/channels/@me',
  isTop: true,
  hasOpener: false
}

describe('shouldMount', () => {
  it('Discord のメインウィンドウにはマウントする', () => {
    expect(shouldMount(base)).toEqual({ mount: true })
  })

  it('splash（data: URL）にはマウントしない', () => {
    expect(shouldMount({ ...base, protocol: 'data:' })).toEqual({ mount: false, reason: 'splash' })
  })

  it('iframe にはマウントしない', () => {
    expect(shouldMount({ ...base, isTop: false })).toEqual({ mount: false, reason: 'iframe' })
  })

  it('ポップアウトは opener で弾く（top-level なので isTop では捕まらない）', () => {
    const got = shouldMount({ ...base, hasOpener: true })
    expect(got.mount).toBe(false)
    if (!got.mount) expect(got.reason).toContain('popout')
  })

  it('ポップアウトは pathname でも弾く', () => {
    const got = shouldMount({ ...base, pathname: '/popout' })
    expect(got.mount).toBe(false)
    if (!got.mount) expect(got.reason).toContain('popout')
  })

  it('Discord 以外のホストにはマウントしない', () => {
    const got = shouldMount({ ...base, hostname: 'example.com' })
    expect(got.mount).toBe(false)
  })
})

describe('isDiscordHost', () => {
  it('discord.com とサブドメインを受け入れる', () => {
    expect(isDiscordHost('discord.com')).toBe(true)
    expect(isDiscordHost('canary.discord.com')).toBe(true)
    expect(isDiscordHost('DISCORD.COM')).toBe(true)
  })

  it('紛らわしいホストを弾く', () => {
    // 前方一致や部分一致で判定すると、こういうものを通してしまう
    expect(isDiscordHost('discord.com.evil.test')).toBe(false)
    expect(isDiscordHost('notdiscord.com')).toBe(false)
    expect(isDiscordHost('discord.com.co')).toBe(false)
    expect(isDiscordHost('evil-discord.com')).toBe(false)
  })
})
