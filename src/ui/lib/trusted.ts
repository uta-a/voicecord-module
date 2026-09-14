/**
 * 本物の入力（ブラウザ自身が作ったイベント）かどうかの検査。
 *
 * VoiceCord の UI は Discord のページと同じ DOM にある。ページ側のスクリプト（悪意のある
 * 埋め込みや他の mod）が `el.click()` や `dispatchEvent` を送ると、ユーザーが押していないのに
 * VC へ音が流れる。**VC への送信につながる操作だけ**、isTrusted === true のイベントに限る
 * （ユーザーの決定: 再生・送信だけ検査する。止める・開閉・閲覧は合成でも効かせる）。
 *
 * 判定はイベントハンドラの入口に置く。store の API（play など）は入場サウンドの自動再生の
 * ように内部からも呼ばれるので、そこには置かない。
 *
 * キーボードでの操作: native の <button> で Enter / Space を押すと、ブラウザが自分で click を
 * 発生させるので isTrusted は true になる（Radix の Primitive が合成するのはカスタムイベントだけで、
 * click は合成しない。node_modules/@radix-ui/react-primitive の dispatchDiscreteCustomEvent）。
 * だから click の isTrusted だけを見れば足りる。
 *
 * 無視したことは黙らせない。ただしトーストは出さない（ページ側から連打されると溢れる）。
 */

interface EventLike {
  isTrusted?: unknown
  nativeEvent?: { isTrusted?: unknown } | null
}

export function isTrustedInput(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const ev = e as EventLike
  // React の合成イベントは元のネイティブイベントで見る。合成イベント側の値は信用しない
  if (ev.nativeEvent !== undefined && ev.nativeEvent !== null) return ev.nativeEvent.isTrusted === true
  return ev.isTrusted === true
}

/** 本物の入力のときだけ fn を呼ぶハンドラを作る。action は警告に出す操作名 */
export function guardTrusted<E>(action: string, fn: (e: E) => void): (e: E) => void {
  return (e) => {
    if (!isTrustedInput(e)) {
      console.warn(`[VoiceCord] 本物の入力ではないため「${action}」を無視しました`)
      return
    }
    fn(e)
  }
}
