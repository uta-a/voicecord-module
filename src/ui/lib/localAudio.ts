// 試聴 / サイドトーンのローカル出力（Web Audio）。VC には流れない自分専用の音。
// engine から 48k/mono/f32le の生 PCM を取り、AudioBuffer にして鳴らす（注入と同じ音）。
// 出力デバイスは AudioContext.setSinkId（Chromium）で切り替える。

interface Playing {
  src: AudioBufferSourceNode
  gain: GainNode
}

// AudioBuffer は 48k/mono/f32 = 192KB/秒。上限が無いと、フォルダを切り替えながら
// 試聴/サイドトーンを鳴らすたびに増え続けて解放されない(キーは内容指紋なので、
// ファイルを保存し直すだけでも新しいエントリが積まれる)。合計バイト数で頭打ちにする。
const CACHE_MAX_BYTES = 64 * 1024 * 1024

export class LocalAudio {
  private ctx: AudioContext | null = null
  private limiter: DynamicsCompressorNode | null = null
  // 挿入順 = 最終使用が古い順(LRU)。あふれたら古い方から捨てる。
  private pcmCache = new Map<string, AudioBuffer>() // srcId -> AudioBuffer
  private cacheBytes = 0
  private voices = new Map<string, Playing>() // key -> 再生中ノード
  private sinkId = '' // '' = 既定デバイス

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 48000 })
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  // 出力直前のリミッタ。モニターの gain は「モニター音量 × 音源別音量 × 送信音量」で、
  // 送信音量は +12dB まで上げられるため 1.0 を軽く超える。送信側は TX_GAIN(-12dB)の
  // ヘッドルームがあるので歪まないが、モニターにはそれが無いので destination で
  // ハードクリップし、**自分にだけ歪んで聞こえる**(相手には歪んでいない)。
  // 「上限で頭打ちにする」で塞ぐと送信音量を動かしてもモニターが変わらなくなるため、
  // 追従は保ったままピークだけ抑える。
  private ensureLimiter(): DynamicsCompressorNode {
    const ctx = this.ensureCtx()
    if (!this.limiter) {
      const c = ctx.createDynamicsCompressor()
      c.threshold.value = -1 // ほぼフルスケールまでは素通し
      c.knee.value = 0 // 折れ点を作らない(ブリックウォール寄り)
      c.ratio.value = 20
      c.attack.value = 0.001
      c.release.value = 0.1
      c.connect(ctx.destination)
      this.limiter = c
    }
    return this.limiter
  }

  // 失敗は握り潰さず throw する。黙って既定デバイスへ落ちると「設定したのに聞こえない」
  // 原因がユーザーから見えないため、呼び出し側で status に出す。
  async setDevice(deviceId: string): Promise<void> {
    this.sinkId = deviceId
    const ctx = this.ensureCtx()
    // 型に無い環境もあるため any 経由。既定('')は 'default' 相当。
    const anyCtx = ctx as unknown as { setSinkId?: (id: string) => Promise<void> }
    if (!anyCtx.setSinkId) throw new Error('この環境では出力デバイスを切り替えられません')
    try {
      await anyCtx.setSinkId(deviceId || '')
    } catch (e) {
      // Windows のデバイス差し替え後など、保存済み ID が消えている場合は既定へ戻す。
      if (deviceId) {
        try {
          await anyCtx.setSinkId('')
          this.sinkId = ''
          return
        } catch {
          /* 既定デバイスへの復帰も失敗した場合は元のエラーを返す */
        }
      }
      throw new Error('モニター出力デバイスの切替に失敗しました: ' + String(e))
    }
  }

  // srcId の PCM を AudioBuffer 化してキャッシュ（f32le mono 48k → 1ch AudioBuffer）。
  private async buffer(srcId: string, pcm: ArrayBuffer): Promise<AudioBuffer> {
    const cached = this.pcmCache.get(srcId)
    if (cached) {
      this.pcmCache.delete(srcId) // 使った順に並べ直す
      this.pcmCache.set(srcId, cached)
      return cached
    }
    const ctx = this.ensureCtx()
    const f32 = new Float32Array(pcm)
    const buf = ctx.createBuffer(1, f32.length, 48000)
    buf.copyToChannel(f32, 0)
    this.pcmCache.set(srcId, buf)
    this.cacheBytes += f32.length * 4
    // 鳴っている音は AudioBufferSourceNode が AudioBuffer を掴んでいるので、
    // ここで捨てても再生は止まらない(次に鳴らすとき作り直すだけ)。
    for (const [k, v] of this.pcmCache) {
      if (this.cacheBytes <= CACHE_MAX_BYTES) break
      if (k === srcId) continue // 今入れたものは残す(1 件で上限を超える場合)
      this.pcmCache.delete(k)
      this.cacheBytes -= v.length * 4
    }
    return buf
  }

  // key(preview / voiceId)で再生。gain は 0..(>1)。onEnded は自然終了時のみ発火。
  async play(
    key: string,
    srcId: string,
    pcm: ArrayBuffer,
    gain: number,
    loop: boolean,
    onEnded?: () => void
  ): Promise<void> {
    const ctx = this.ensureCtx()
    // 停止中の AudioContext で start() しても例外にならず無音になるため、再開を待って確かめる。
    if (ctx.state !== 'running') await ctx.resume()
    if (ctx.state !== 'running') throw new Error('音声出力を開始できませんでした（AudioContext: ' + ctx.state + '）')
    // 再生ごとの sink 再適用は失敗しても鳴らす方を優先(既定デバイスで出る)。
    // 切替失敗の通知は設定変更時の setDevice 側で行う。
    if (this.sinkId) await this.setDevice(this.sinkId).catch(() => {})
    this.stop(key)
    const buf = await this.buffer(srcId, pcm)
    const source = ctx.createBufferSource()
    source.buffer = buf
    source.loop = loop
    const gainNode = ctx.createGain()
    gainNode.gain.value = Math.max(0, gain)
    source.connect(gainNode).connect(this.ensureLimiter())
    source.onended = () => {
      // stop() 由来かどうかを問わず voices から除去。自然終了だけ onEnded を呼ぶ。
      if (this.voices.get(key)?.src === source) {
        this.voices.delete(key)
        if (!loop) onEnded?.()
      }
    }
    this.voices.set(key, { src: source, gain: gainNode })
    source.start()
  }

  setVolume(key: string, gain: number): void {
    const v = this.voices.get(key)
    if (v) v.gain.gain.value = Math.max(0, gain)
  }

  stop(key: string): void {
    const v = this.voices.get(key)
    if (!v) return
    this.voices.delete(key)
    try {
      v.src.onended = null
      v.src.stop()
    } catch {
      /* すでに停止済み */
    }
  }

  stopAll(): void {
    for (const key of [...this.voices.keys()]) this.stop(key)
  }
}

// Windows の仮想エンドポイント。deviceId そのものが意味を持つので固定名で見せる。
const VIRTUAL_LABEL: Record<string, string> = {
  default: '既定デバイス',
  communications: '既定の通信デバイス'
}

// 出力デバイス一覧（audiooutput）。マイク権限が無いと label が空になり
// 「出力デバイス (commun)」のような選べない名前になるため、先に権限を取ってから列挙する。
export async function listOutputDevices(): Promise<{ id: string; label: string }[]> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices()
    const needsLabel = devices.some((d) => d.kind === 'audiooutput' && !d.label)
    if (needsLabel) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop()) // 権限取得が目的。録音はしない
        devices = await navigator.mediaDevices.enumerateDevices()
      } catch {
        /* 権限が取れなければラベル無しのまま出す */
      }
    }
    return devices
      .filter((d) => d.kind === 'audiooutput')
      // 'default' は Select 側が「既定デバイス」項目(値='')として別に出すので重複させない。
      .filter((d) => d.deviceId !== 'default')
      .map((d) => ({
        id: d.deviceId,
        label: VIRTUAL_LABEL[d.deviceId] ?? (d.label || d.deviceId)
      }))
  } catch {
    return []
  }
}
