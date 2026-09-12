import type { EngineEvent, PlayReq } from '../shared/types.js'
import type { Injector } from './injector.js'
import type { FridaGate } from './transmit.js'

/**
 * エンジン統括。injector と gate をまとめ、hook.js のイベントを整理して上へ流す。
 *
 * 移植元（desktop/src/main/engine/index.ts）から ffmpeg 由来のものを全部落とした。
 * PCM は renderer が `decodeAudioData` で作って送ってくるので、ここでは
 * 「受け取った PCM を hook へ渡し、hook 側に何が載っているかを管理する」だけでよい。
 * フォルダ走査も patcher 側へ移った。
 */

/**
 * hook 側 sources は Discord のプロセスに常駐する Float32Array
 * （48k / mono / f32 = 192KB/秒）。上限が無いと、フォルダを切り替えながら
 * 鳴らすたびに Discord のメモリが増え続けて減らない。
 * 使った順に並ぶ Set で保持し、あふれたら古い順に unload する。
 */
export const PRELOAD_MAX = 48

/** 音源キー。指紋を混ぜるので、同名で差し替えても旧 PCM を鳴らさない */
export function sourceKey(srcId: string, fp: string): string {
  return `${srcId}@${fp}`
}

export interface EngineCore {
  /** hook.js から来たイベントを捌く。ゲートへ回し、上へ流す */
  onHookEvent(p: EngineEvent): void
  /** renderer がデコードした PCM を hook へ渡す */
  preloadPcm(srcId: string, fp: string, pcm: Buffer): { key: string; sent: boolean }
  play(req: PlayReq): string | null
  stop(voiceId: string): void
  stopAll(): void
  setVoiceVolume(voiceId: string, vol: number): void
  setMaster(v: number): void
  preOpenGate(guardMs: number): void
  calibStart(tag: string, frames: number): void
  calibStop(): void
  /** attach / detach の境界で呼ぶ。hook 側と手元の記録を揃え直す */
  resetSession(): void
  /** 診断用。hook 側に載っている音源の数 */
  preloadedCount(): number
}

export interface EngineCoreDeps {
  inj: Injector
  gate: FridaGate
  emit: (p: EngineEvent) => void
}

export function createEngineCore(deps: EngineCoreDeps): EngineCore {
  const { inj, gate, emit } = deps

  /** 挿入順 = 最終使用が古い順（LRU）。has で二重プリロードを避け、退避の順序にも使う */
  const preloaded = new Set<string>()
  /**
   * 再生中の voiceId -> 音源キー。鳴っている音源を unload すると hook 側で
   * 「source が消えた voice」として無音フェードアウトされるので、退避から外す。
   */
  const activeKeys = new Map<string, string>()
  let master = 0.8

  const resetSession = (): void => {
    preloaded.clear()
    activeKeys.clear()
  }

  /**
   * hook 側に常駐する音源を PRELOAD_MAX 件までに抑える。
   * 鳴っている音源を落とすとその音が途中で消えるので、再生中のキーは飛ばす。
   */
  const evict = (): void => {
    if (preloaded.size <= PRELOAD_MAX) return
    const inUse = new Set(activeKeys.values())
    for (const key of preloaded) {
      if (preloaded.size <= PRELOAD_MAX) break
      if (inUse.has(key)) continue
      preloaded.delete(key)
      inj.unload(key)
    }
  }

  return {
    onHookEvent: (p) => {
      if (p.ev === 'activity') {
        gate.onActivity((p as { playing?: boolean }).playing === true)
      } else if (p.ev === 'vc') {
        // 退出（active=false）が一定時間続いて初めて clearForced する。
        // 連打時に hb 停滞で一過性の vc=false が来ても、確定前に active へ戻れば
        // 予約済みの doClose が生き残ってゲートは正常に閉じる
        gate.onVcActive((p as { active?: boolean }).active === true)
      } else if (p.ev === 'detached') {
        // hook.js は消えているので activity=false も voiceEnded も二度と来ない。
        // ゲートの内部状態と、hook 側 sources に対応する記録を次の attach へ
        // 持ち越さない。gateClose の post は script=null で no-op になるため、
        // 解放済み Connection* は触らない
        gate.revertNow()
        resetSession()
      } else if (p.ev === 'voiceEnded' || p.ev === 'playRejected') {
        const vid = (p as { voiceId?: string }).voiceId
        const reason = String((p as { reason?: string }).reason ?? '')
        // hook 側に音源が無いと言われた = 手元の preloaded と hook の sources がズレた。
        // ズレる経路は複数あり（unload と preload は別チャネルなので処理順が保証されない、
        // onPcm が例外を投げる、など）、fp が変わらない限り自力では戻らないので、
        // その音源だけが恒久的に「音源データを読み込めません」になる終端が生まれる。
        // 記録を落としておけば次の再生で必ず送り直され、原理的にその終端が消える
        if (vid !== undefined && reason.startsWith('no source')) {
          const key = activeKeys.get(vid)
          if (key !== undefined) preloaded.delete(key)
        }
        if (vid !== undefined) activeKeys.delete(vid)
      }
      emit(p)
    },

    preloadPcm: (srcId, fp, pcm) => {
      const key = sourceKey(srcId, fp)
      if (preloaded.has(key)) {
        // 既に hook 側に載っている。使った順に並べ直すだけで、Discord の
        // プロセスへ 1MB を投げ直さない
        preloaded.delete(key)
        preloaded.add(key)
        return { key, sent: false }
      }
      if (!inj.attached) throw new Error('audio プロセスに噛んでいません')
      inj.preload(key, pcm)
      preloaded.add(key)
      evict()
      return { key, sent: true }
    },

    play: (req) => {
      if (!inj.attached) throw new Error('audio プロセスに噛んでいません')
      const key = sourceKey(req.srcId, req.fp)
      if (!preloaded.has(key)) {
        // 呼び出し側が preload を忘れた、あるいは間に再アタッチが挟まった。
        // 無言で null を返すと「押しても鳴らない」だけになるので理由を返す
        throw new Error('音源が hook 側にありません。読み込み直してください')
      }
      preloaded.delete(key)
      preloaded.add(key)
      const vid = inj.play(key, req.vol)
      if (vid !== null) activeKeys.set(vid, key)
      return vid
    },

    stop: (voiceId) => inj.stop(voiceId),
    stopAll: () => inj.stopAll(),
    setVoiceVolume: (voiceId, vol) => inj.setVolume(voiceId, vol),

    setMaster: (v) => {
      master = v
      inj.setMaster(v)
    },

    preOpenGate: (guardMs) => {
      if (!inj.attached) return
      gate.preOpen(guardMs)
    },

    calibStart: (tag, frames) => {
      if (!inj.attached) return
      inj.calibStart(tag, frames)
    },
    calibStop: () => {
      if (!inj.attached) return
      inj.calibStop()
    },

    resetSession: () => {
      resetSession()
      // JS 既定とのズレ解消。新しい hook は master=1.0 で始まる
      if (inj.attached) inj.setMaster(master)
    },

    preloadedCount: () => preloaded.size
  }
}
