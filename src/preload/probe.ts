/**
 * isolated world で何が使えるかの自己診断。
 *
 * UI を preload の isolated world で動かす設計は、そこで Web Audio と
 * デバイス列挙が使えることに乗っている。試聴・サイドトーン・出力デバイス
 * 切り替えが全部そこに依存しているので、使えないなら設計を変えるしかない。
 *
 * 結果は #vc-root の data 属性に書く。メインワールド（DevTools や CDP）からも
 * DOM 経由で読めるので、実機での確認を人の目に頼らず機械的に行える。
 */

export interface ProbeResult {
  /** AudioContext を 48kHz で作れるか */
  audioContext: boolean
  /** 実際に得られたサンプルレート */
  sampleRate: number | null
  /** 出力デバイスを切り替えられるか */
  setSinkId: boolean
  /** デバイス列挙ができるか */
  enumerateDevices: boolean
  /** ラベル付きで列挙できたデバイス数（0 だと権限が無い可能性がある） */
  labeledDevices: number | null
  /** CSSOM でスタイルを流し込めるか */
  adoptedStyleSheets: boolean
  errors: string[]
}

export function probeSync(): ProbeResult {
  const errors: string[] = []
  const r: ProbeResult = {
    audioContext: false,
    sampleRate: null,
    setSinkId: false,
    enumerateDevices: false,
    labeledDevices: null,
    adoptedStyleSheets: false,
    errors
  }

  try {
    const AC = globalThis.AudioContext
    if (typeof AC === 'function') {
      const ctx = new AC({ sampleRate: 48000 })
      r.audioContext = true
      r.sampleRate = ctx.sampleRate
      // 診断のために作っただけなので、すぐ閉じる
      void ctx.close()
    }
  } catch (e) {
    errors.push(`AudioContext: ${msg(e)}`)
  }

  try {
    // 出力先の切り替えは AudioContext と HTMLMediaElement のどちらかにあればよい
    const onCtx =
      typeof globalThis.AudioContext === 'function' &&
      'setSinkId' in globalThis.AudioContext.prototype
    const onMedia =
      typeof globalThis.HTMLMediaElement === 'function' &&
      typeof globalThis.HTMLMediaElement.prototype.setSinkId === 'function'
    r.setSinkId = onCtx || onMedia
  } catch (e) {
    errors.push(`setSinkId: ${msg(e)}`)
  }

  try {
    r.enumerateDevices = typeof navigator?.mediaDevices?.enumerateDevices === 'function'
  } catch (e) {
    errors.push(`enumerateDevices: ${msg(e)}`)
  }

  try {
    r.adoptedStyleSheets = Array.isArray((document as Document).adoptedStyleSheets)
  } catch (e) {
    errors.push(`adoptedStyleSheets: ${msg(e)}`)
  }

  return r
}

/** ラベル付きデバイスの数だけは非同期でしか取れない */
export async function probeDevices(base: ProbeResult): Promise<ProbeResult> {
  if (!base.enumerateDevices) return base
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return { ...base, labeledDevices: devices.filter((d) => d.label.length > 0).length }
  } catch (e) {
    return { ...base, errors: [...base.errors, `enumerateDevices(): ${msg(e)}`] }
  }
}

/** 人が読む 1 行にまとめる */
export function summarizeProbe(r: ProbeResult): string {
  const parts = [
    `AudioContext=${r.audioContext ? `ok(${r.sampleRate}Hz)` : 'NG'}`,
    `setSinkId=${r.setSinkId ? 'ok' : 'NG'}`,
    `enumerateDevices=${r.enumerateDevices ? 'ok' : 'NG'}`,
    `labeled=${r.labeledDevices ?? '-'}`,
    `adoptedStyleSheets=${r.adoptedStyleSheets ? 'ok' : 'NG'}`
  ]
  return parts.join(' / ') + (r.errors.length > 0 ? ` / errors: ${r.errors.join('; ')}` : '')
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
