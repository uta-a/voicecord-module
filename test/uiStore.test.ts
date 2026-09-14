import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '../src/ui/mockApi.js'
import type { Api, EngineEvent } from '../src/shared/types.js'

describe('UI store engine lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('../src/ui/mockApi.js')
    vi.resetModules()
  })

  it('engineLost clears stale playback but keeps the auto-reattach connection usable', async () => {
    const listeners = new Set<(event: EngineEvent) => void>()
    const api: Api = {
      ...createMockApi(),
      onEngineEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    vi.doMock('../src/ui/mockApi.js', () => ({ mockApi: api }))
    const { useStore } = await import('../src/ui/store.js')

    await useStore.getState().init()
    useStore.setState({
      attached: true,
      connection: 'connected',
      micTransmit: 'open',
      previewSrc: 'preview-source',
      voices: [
        { voiceId: 'v1', srcId: 'chime', name: 'chime', volume: 1, kind: 'vc' },
        { voiceId: 'preview', srcId: 'preview-source', name: 'preview-source', volume: 1, kind: 'preview' }
      ]
    })

    for (const listener of listeners) listener({ ev: 'engineLost', code: 9 })

    const state = useStore.getState()
    expect(state.voices).toEqual([])
    expect(state.previewSrc).toBeNull()
    expect(state.micTransmit).toBe('unknown')
    expect(state.attached).toBe(true)
    expect(state.connection).toBe('connected')

    await state.play(state.sounds[0]!.id)
    expect(useStore.getState().voices).toHaveLength(1)
    expect(useStore.getState().voices[0]?.kind).toBe('vc')
  })
})
