import { describe, expect, it } from 'vitest'
import { isRunning, parseTasklist, taskkillCommand, tasklistCommand } from '../src/manager/patch/running.js'

// 実機（Windows 11）の tasklist から採った出力
const RUNNING = [
  '"Discord.exe","35728","Console","2","70,624 K"',
  '"Discord.exe","23652","Console","2","504 K"',
  '"Discord.exe","8300","Console","2","111,328 K"'
].join('\r\n')

const NOT_RUNNING = 'INFO: No tasks are running which match the specified criteria.'
const NOT_RUNNING_JA = '情報: 指定された条件に一致するタスクは実行されていません。'

describe('parseTasklist', () => {
  it('CSV 行から PID を拾う', () => {
    expect(parseTasklist(RUNNING, 'Discord.exe')).toEqual([35728, 23652, 8300])
  })

  it('該当なしのメッセージを PID と誤解しない（ロケール非依存）', () => {
    expect(parseTasklist(NOT_RUNNING, 'Discord.exe')).toEqual([])
    expect(parseTasklist(NOT_RUNNING_JA, 'Discord.exe')).toEqual([])
  })

  it('イメージ名が違えば拾わない（Discord と DiscordCanary を混同しない）', () => {
    expect(parseTasklist(RUNNING, 'DiscordCanary.exe')).toEqual([])
  })

  it('大文字小文字は無視する', () => {
    expect(parseTasklist(RUNNING, 'discord.exe')).toHaveLength(3)
  })

  it('空出力でも落ちない', () => {
    expect(parseTasklist('', 'Discord.exe')).toEqual([])
  })
})

describe('isRunning', () => {
  it('起動中なら running:true と PID', () => {
    expect(isRunning(() => RUNNING, 'Discord.exe')).toEqual({
      running: true,
      pids: [35728, 23652, 8300]
    })
  })

  it('未起動なら running:false', () => {
    expect(isRunning(() => NOT_RUNNING, 'DiscordCanary.exe')).toEqual({ running: false, pids: [] })
  })

  it('判定できないときは「起動している」と見なす（分からないまま差し替えに進まない）', () => {
    const got = isRunning(() => {
      throw new Error('tasklist が無い')
    }, 'Discord.exe')
    expect(got.running).toBe(true)
  })
})

describe('tasklistCommand', () => {
  it('シェルを介さない引数配列を返す', () => {
    expect(tasklistCommand('DiscordCanary.exe')).toEqual([
      'tasklist',
      '/FI',
      'IMAGENAME eq DiscordCanary.exe',
      '/FO',
      'CSV',
      '/NH'
    ])
  })
})

describe('taskkillCommand', () => {
  it('イメージ名でツリーごと強制終了する引数配列を返す（シェルを介さない）', () => {
    expect(taskkillCommand('DiscordCanary.exe')).toEqual(['taskkill', '/F', '/T', '/IM', 'DiscordCanary.exe'])
  })
})
