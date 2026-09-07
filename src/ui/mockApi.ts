import type {
  Api,
  AttachResult,
  BuildKey,
  CalibMeasure,
  EngineEvent,
  LoadedConfig,
  PlayReq,
  SoundItem,
  SourceStats
} from '@shared/types'

/**
 * エンジンのモック。
 *
 * M1 にはエンジンが無い（frida は M3）。UI を端から端まで描画・操作できるように、
 * window.api の代わりにこれを噛ませる。store.ts はここだけを見ているので、
 * 実装が入ったら store.ts の 1 行を差し替えれば済む。
 *
 * 「もっともらしい値」を返すことが目的なので、状態は最小限しか持たない。
 * ただし再生・停止・計測は UI の見た目が変わるところまで一通り動かす
 * （黙って何も起きないと、モックなのか壊れているのか見分けが付かない）。
 */

const MOCK_FOLDER = 'C:\\Users\\you\\Music\\VoiceCord'

const MOCK_NAMES = [
  'ドラムロール',
  '拍手',
  'ファンファーレ',
  'boing',
  'レーザー',
  'コイン',
  'ぱふぱふ',
  'ため息',
  'ブザー',
  'キラーン',
  'ドンッ',
  'わーい'
]

const MOCK_SOUNDS: SoundItem[] = MOCK_NAMES.map((n, i) => ({
  id: n,
  name: `${n}.wav`,
  path: `${MOCK_FOLDER}\\${n}.wav`,
  // 内容指紋。実装では mtimeNs_size なので、それらしい形にしておく
  fp: `mock${i}_${1000 + i * 137}`
}))

/** 音源ごとにばらつかせた音量。校正済みの環境の見た目に近づける */
const MOCK_SOURCE_VOLUMES: Record<string, number> = {
  ドラムロール: 0.85,
  拍手: 0.4,
  ファンファーレ: 1.15,
  boing: 0.6,
  レーザー: 0.75
}

const SAMPLE_RATE = 48000

/** 音源 1 本のおおよその長さ（秒）。fp から決めるので毎回同じ値になる */
function durationOf(fp: string): number {
  let h = 0
  for (const ch of fp) h = (h * 31 + ch.charCodeAt(0)) % 997
  return 0.6 + (h % 20) / 10
}

/**
 * 48k / mono / f32 の PCM。試聴とサイドトーンが実際に鳴らないと、
 * 出力デバイス切り替えやモニター音量が動いているか確かめられない。
 * 減衰する正弦波にしてある（無音を返すと「壊れている」と区別が付かない）。
 */
function synthPcm(fp: string): ArrayBuffer {
  const seconds = durationOf(fp)
  const n = Math.round(SAMPLE_RATE * seconds)
  const f32 = new Float32Array(n)
  const hz = 220 + (fp.length % 7) * 55
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    f32[i] = Math.sin(2 * Math.PI * hz * t) * Math.exp(-3 * t) * 0.6
  }
  return f32.buffer
}

export function createMockApi(): Api {
  const listeners = new Set<(p: EngineEvent) => void>()
  const emit = (p: EngineEvent): void => {
    for (const cb of listeners) cb(p)
  }
  const later = (ms: number, fn: () => void): void => void setTimeout(fn, ms)

  const config: LoadedConfig = {
    build: 'canary',
    folder: MOCK_FOLDER,
    master: 1.0,
    sidetoneEnabled: false,
    sidetoneDevice: '',
    sidetoneVolume: 0.7,
    sourceVolumes: { ...MOCK_SOURCE_VOLUMES },
    entrySoundEnabled: false,
    entrySoundSrcId: '',
    entrySoundVolume: 1.0,
    entryDelayMs: 0,
    entryLeaveDebounceMs: 2500,
    normalizeRefDbfs: -14,
    calibration: null
  }

  let voiceSeq = 0
  const playing = new Map<string, ReturnType<typeof setTimeout>>()
  let calibTimer: ReturnType<typeof setInterval> | null = null

  const stopCalib = (): void => {
    if (calibTimer === null) return
    clearInterval(calibTimer)
    calibTimer = null
  }

  return {
    getConfig: async () => ({ ...config, sourceVolumes: { ...config.sourceVolumes } }),
    saveConfig: async (partial) => {
      Object.assign(config, partial)
    },
    listBuilds: async () => ['stable', 'canary'] as BuildKey[],

    attach: async (build): Promise<AttachResult> => {
      // 実装では audio utility プロセスを探しに行く。ここは必ず見つかったことにする。
      // VC 在席（'vc'）とゲート情報は attach の少し後に届く、という実機の順番に合わせる。
      later(200, () => emit({ ev: 'vc', active: true }))
      later(400, () => emit({ ev: 'gateInfo', conn: '0x0000mock' }))
      return { ok: true, pid: 4242, label: `Discord ${build}（モック）` }
    },
    detach: async () => {
      emit({ ev: 'detached' })
    },

    scanFolder: async (folder) => (folder ? MOCK_SOUNDS.map((s) => ({ ...s })) : []),
    chooseFolder: async () => MOCK_FOLDER,
    getPcm: async (path) => synthPcm(path),

    play: async (req: PlayReq) => {
      const voiceId = `mock-v${++voiceSeq}`
      // 鳴り終わりを返さないと再生中一覧に行が溜まり続ける
      playing.set(
        voiceId,
        setTimeout(
          () => {
            playing.delete(voiceId)
            emit({ ev: 'voiceEnded', voiceId })
          },
          durationOf(req.fp) * 1000
        )
      )
      emit({ ev: 'gate', open: true })
      return voiceId
    },
    stop: async (vid) => {
      const t = playing.get(vid)
      if (t) clearTimeout(t)
      playing.delete(vid)
      emit({ ev: 'voiceEnded', voiceId: vid })
    },
    stopAll: async () => {
      for (const vid of [...playing.keys()]) {
        const t = playing.get(vid)
        if (t) clearTimeout(t)
        playing.delete(vid)
        emit({ ev: 'voiceEnded', voiceId: vid })
      }
    },
    setVoiceVolume: async () => {},
    setMaster: async (v) => {
      config.master = v
    },
    openGate: async () => {
      emit({ ev: 'gate', open: true })
    },

    calibStart: async (tag, frames) => {
      stopCalib()
      let done = 0
      const measure = (): CalibMeasure => {
        // 声らしいレベル（-24dBFS 前後）で揺らす
        const vNow = 0.05 + Math.random() * 0.05
        return {
          tag,
          frames: done,
          budget: frames,
          total: done * 480,
          clip: 0,
          master: config.master,
          txGain: 0.25,
          vRms: 0.063,
          vPeak: 0.21,
          vN: done * 300,
          iRms: 0,
          iPeak: 0,
          iN: 0,
          vNow,
          iNow: 0
        }
      }
      // 実機は 100 フレーム ≒ 1 秒。100ms ごとに 10 フレーム進める
      calibTimer = setInterval(() => {
        done = Math.min(frames, done + 10)
        if (done < frames) {
          emit({ ev: 'calib', ...measure() })
          return
        }
        stopCalib()
        // 確定値はフレーム毎の平均二乗から測り直される（store.ts の finalizeMeasure）
        const m = measure()
        emit({ ev: 'calibDone', ...m, vBlocks: Array.from({ length: 40 }, () => 0.004) })
      }, 100)
    },
    calibStop: async () => {
      stopCalib()
    },

    sourceStats: async (path): Promise<SourceStats> => {
      const seconds = durationOf(path)
      return { rms: 0.14, peak: 0.86, samples: Math.round(SAMPLE_RATE * seconds), activeRatio: 0.72 }
    },

    onEngineEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

export const mockApi: Api = createMockApi()
