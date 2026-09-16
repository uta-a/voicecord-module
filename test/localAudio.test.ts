import { afterEach, describe, expect, it } from 'vitest'
import { LocalAudio } from '../src/ui/lib/localAudio.js'

describe('LocalAudio', () => {
  const original = globalThis.AudioContext

  afterEach(() => {
    globalThis.AudioContext = original
  })

  it('消えた出力デバイスは既定デバイスへ戻す', async () => {
    const calls: string[] = []
    class FakeAudioContext {
      setSinkId = async (id: string): Promise<void> => {
        calls.push(id)
        if (id !== '') throw new DOMException('device not found', 'NotFoundError')
      }
    }
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext

    await new LocalAudio().setDevice('removed-device')
    expect(calls).toEqual(['removed-device', ''])
  })
  it('停止中の AudioContext は再開を待ってから鳴らし、再開できなければ失敗を返す', async () => {
    const log: string[] = []
    let resumable = true
    class FakeAudioContext {
      state = 'suspended'
      destination = {}
      resume = async (): Promise<void> => {
        log.push('resume')
        if (resumable) this.state = 'running'
      }
      createBuffer = () => ({ length: 1, copyToChannel: () => {} })
      createBufferSource = () => ({
        connect: (n: unknown) => n,
        start: () => log.push('start:' + this.state)
      })
      createGain = () => ({ gain: { value: 0 }, connect: (n: unknown) => n })
      createDynamicsCompressor = () => ({
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: () => {}
      })
    }
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext

    await new LocalAudio().play('preview', 'a', new Float32Array(1).buffer, 1, false)
    expect(log.at(-1)).toBe('start:running')

    resumable = false
    await expect(new LocalAudio().play('preview', 'a', new Float32Array(1).buffer, 1, false)).rejects.toThrow()
  })
})
