/**
 * Discord のサウンドボードのサウンド ID の形。main（取得とキャッシュ）と preload（DOM から拾う）で
 * 同じ判定を使う。ID は URL とキャッシュのファイル名にそのまま入るので、数字以外は一切通さない。
 */
const SOUND_ID_RE = /^\d{1,20}$/

export function isSoundboardSoundId(id: unknown): id is string {
  return typeof id === 'string' && SOUND_ID_RE.test(id)
}
