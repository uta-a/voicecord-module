/**
 * 音源のデコード。
 *
 * ffmpeg は使わない。Discord は proprietary codec 付きの ffmpeg.dll を積んでいて、
 * renderer の `decodeAudioData` からそのまま使える。外部プロセスを起こさずに済み、
 * ディスクキャッシュ（原子的書き込み・ハッシュ・inflight 合流）もまるごと不要になる。
 *
 * isolated world で `AudioContext` が使えることは M1-g で実測済み
 * （48000Hz / setSinkId / enumerateDevices すべて ok）。
 */

/**
 * 試聴とラウドネス計測のレート。
 *
 * `lib/localAudio.ts` が 48000 で AudioBuffer を作るので、ここも 48000 で揃える。
 * **注入用のレートとは別物**。注入側は hook が実際に消費するレートに合わせる
 * （Canary 1.0.1169 では 32000 だった）。
 */
export const PREVIEW_SAMPLE_RATE = 48000

/** 生の f32le。デコード不要で直読みできる */
export const RAW_F32_EXT = '.f32'

export function isRawF32(name: string): boolean {
  return name.toLowerCase().endsWith(RAW_F32_EXT)
}

/**
 * 生 f32le を Float32Array にする。
 * 4 の倍数でないファイルは末尾の端数を捨てる（throw して一覧から消すほどではない）。
 */
export function rawF32ToMono(bytes: ArrayBuffer): Float32Array {
  const usable = bytes.byteLength - (bytes.byteLength % 4)
  return new Float32Array(bytes.slice(0, usable))
}

/**
 * 複数チャンネルを平均してモノラルにする。
 *
 * 片チャンネルだけ取ると、左右で位相の違う音源（ステレオ拡張がかかったもの）で
 * 音量が体感と食い違う。移植元と同じく平均を取る。
 */
export function toMono(channels: ArrayLike<number>[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  const first = channels[0] as ArrayLike<number>
  if (channels.length === 1) return Float32Array.from(first)
  const n = first.length
  const out = new Float32Array(n)
  for (const ch of channels) {
    const len = Math.min(n, ch.length)
    for (let i = 0; i < len; i++) out[i] = (out[i] as number) + (ch[i] as number)
  }
  const inv = 1 / channels.length
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * inv
  return out
}

/** decodeAudioData の抽象。テストでは差し替える */
export interface AudioDecoder {
  (bytes: ArrayBuffer): Promise<ArrayLike<number>[]>
}

/**
 * OfflineAudioContext を使うデコーダ。
 *
 * 指定したレートで作ると `decodeAudioData` がそこへリサンプルして返す。
 * ブラウザ実装のリサンプラなので、自前の線形補間よりエイリアスが少ない。
 * 手書きのリサンプラを持たずに済むのが、この形にしている理由。
 */
export function createOfflineDecoder(sampleRate: number = PREVIEW_SAMPLE_RATE): AudioDecoder {
  return async (bytes: ArrayBuffer): Promise<ArrayLike<number>[]> => {
    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    const buf = await ctx.decodeAudioData(bytes)
    const chans: Float32Array[] = []
    for (let i = 0; i < buf.numberOfChannels; i++) chans.push(buf.getChannelData(i))
    return chans
  }
}

/**
 * ファイルの中身を 48kHz / mono / f32 にする。
 *
 * デコードできない形式（Chromium が codec を持たない .wma など）はここで throw する。
 * 呼び出し側は**一覧から黙って消さず**、タイルにエラーとして出すこと。
 */
export async function decodeToMono(
  bytes: ArrayBuffer,
  name: string,
  decode: AudioDecoder
): Promise<Float32Array> {
  if (isRawF32(name)) return rawF32ToMono(bytes)
  let channels: ArrayLike<number>[]
  try {
    channels = await decode(bytes)
  } catch (e) {
    throw new Error(`この形式は再生できません（${name}）: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (channels.length === 0) throw new Error(`音声が入っていません（${name}）`)
  return toMono(channels)
}
