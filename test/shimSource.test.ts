import { describe, expect, it } from 'vitest'
import { parseShimChain, renderShimSource, SHIM_MARKER } from '../src/manager/patch/shimSource.js'

const BS = String.fromCharCode(92)
/** 'C:/a/b' -> 'C:\a\b' （リテラルのバックスラッシュを書かずに Windows パスを作る） */
const win = (s: string): string => s.split('/').join(BS)

const VOICECORD = win('C:/Users/utaaa/AppData/Local/VoiceCord/dist/patcher.js')
const VENCORD = win('C:/Users/utaaa/AppData/Roaming/Vencord/dist/patcher.js')

describe('renderShimSource / parseShimChain', () => {
  it('Windows パスを含む連鎖を往復できる', () => {
    const chain = [VOICECORD, VENCORD]
    expect(parseShimChain(renderShimSource(chain))).toEqual(chain)
  })

  it('生成物の中でバックスラッシュがエスケープされている', () => {
    const src = renderShimSource([VOICECORD])
    expect(src).toContain('C:' + BS + BS + 'Users')
    const m = /var CHAIN = (\[[^\]]*\]);/.exec(src)
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual([VOICECORD])
  })

  it('VoiceCord 単独（Vencord 不在）の連鎖も往復できる', () => {
    expect(parseShimChain(renderShimSource([VOICECORD]))).toEqual([VOICECORD])
  })

  it('空の連鎖も壊れない', () => {
    expect(parseShimChain(renderShimSource([]))).toEqual([])
  })

  it('VoiceCord のマーカーが無い shim は null を返す（他 mod の shim を壊さない）', () => {
    expect(parseShimChain(`require(${JSON.stringify(VENCORD)})`)).toBeNull()
  })

  it('マーカーはあるが CHAIN が壊れている場合は null', () => {
    expect(parseShimChain(`// ${SHIM_MARKER}\nvar CHAIN = [oops];`)).toBeNull()
  })

  it('VoiceCord は必ず Vencord より先に require される', () => {
    // Vencord の patcher は最終行で Discord をブートし切るため、順序が逆だと
    // preload の登録が間に合わない。
    const chain = parseShimChain(renderShimSource([VOICECORD, VENCORD]))!
    expect(chain[0]).toBe(VOICECORD)
    expect(chain[1]).toBe(VENCORD)
  })
})
