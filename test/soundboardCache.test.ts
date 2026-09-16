import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSoundboardCache,
  defaultSoundboardCacheDir,
  isSoundboardSoundId,
  resolveReadableSoundPath,
  SOUNDBOARD_CDN_HOST,
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_CONCURRENT,
  type SoundboardHttpResponse
} from '../src/patcher/soundboardCache.js'
import type { SoundsFs } from '../src/patcher/soundsFs.js'

/**
 * ほかのサーバーのサウンドの取得とキャッシュ。
 *
 * 外部から取ってきたファイルを一時フォルダへ書き、renderer に読ませる経路なので、
 * 「決まった CDN からだけ」「決まった大きさ・形式だけ」「決まったフォルダの決まった名前だけ」を固定する。
 */

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-soundboard-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Fake {
  status?: number
  headers?: Record<string, string | undefined>
  chunks?: Uint8Array[]
  /** true なら応答を返さない（タイムアウトの確認用） */
  hang?: boolean
  /** 応答までの遅れ。signal は無視する（止まらない実装でも読み続けないことの確認用） */
  responseDelayMs?: number
  /** チャンクごとの遅れ。signal は無視する */
  chunkDelayMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeRequest(fake: Fake): {
  request: (url: string, signal: AbortSignal) => Promise<SoundboardHttpResponse>
  urls: string[]
  aborted: () => number
  /** 読まれたチャンク数 */
  reads: () => number
} {
  const urls: string[] = []
  let aborted = 0
  let reads = 0
  return {
    urls,
    aborted: () => aborted,
    reads: () => reads,
    request: async (url, signal) => {
      urls.push(url)
      signal.addEventListener('abort', () => void (aborted += 1))
      if (fake.hang) return new Promise(() => undefined)
      if (fake.responseDelayMs !== undefined) await sleep(fake.responseDelayMs)
      const chunks = fake.chunks ?? [new Uint8Array([1, 2, 3])]
      return {
        status: fake.status ?? 200,
        headers: fake.headers ?? { 'content-type': 'audio/ogg' },
        body: (async function* () {
          for (const c of chunks) {
            if (fake.chunkDelayMs !== undefined) await sleep(fake.chunkDelayMs)
            reads += 1
            yield c
          }
        })(),
        abort: () => void (aborted += 1)
      }
    }
  }
}

/** node の fs を SoundsFs の形にする（patcher/index.ts と同じ包み方） */
const realSoundsFs: SoundsFs = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  statSyncBig: (p) => {
    const st = fs.statSync(p, { bigint: true })
    return { mtimeNs: st.mtimeNs, size: st.size }
  },
  readdirSync: (p) => fs.readdirSync(p),
  realpathSync: (p) => fs.realpathSync(p)
}

/** 外側の一時フォルダを作って fn に渡し、終わったら消す */
function withOutside(fn: (outside: string) => void): void {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-soundboard-out-'))
  try {
    fn(outside)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
}

describe('isSoundboardSoundId', () => {
  it('1〜20 桁の数字だけを通す', () => {
    expect(isSoundboardSoundId('1366072719438905447')).toBe(true)
    expect(isSoundboardSoundId('1')).toBe(true)
    expect(isSoundboardSoundId('')).toBe(false)
    expect(isSoundboardSoundId('123456789012345678901')).toBe(false)
    expect(isSoundboardSoundId('12a')).toBe(false)
    expect(isSoundboardSoundId('../1')).toBe(false)
    expect(isSoundboardSoundId('1\n')).toBe(false)
    expect(isSoundboardSoundId(12 as unknown as string)).toBe(false)
  })
})

describe('createSoundboardCache', () => {
  it('キャッシュ先は一時フォルダの VoiceCord/soundboard', () => {
    expect(defaultSoundboardCacheDir()).toBe(path.join(os.tmpdir(), 'VoiceCord', 'soundboard'))
  })

  it('CDN の決まった URL から取り、一時ファイルを経て <id>.ogg に置く', async () => {
    const http = fakeRequest({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] })
    const cache = createSoundboardCache({ dir, request: http.request })
    const p = await cache.fetchSoundboardSound('123')
    expect(http.urls).toEqual([`https://${SOUNDBOARD_CDN_HOST}/soundboard-sounds/123`])
    expect(p).toBe(path.join(dir, '123.ogg'))
    expect([...fs.readFileSync(p)]).toEqual([1, 2, 3])
    // 一時ファイルは残さない
    expect(fs.readdirSync(dir)).toEqual(['123.ogg'])
  })

  it('audio/mpeg は .mp3 にする（パラメータ付きの Content-Type も読む）', async () => {
    const http = fakeRequest({ headers: { 'content-type': 'Audio/MPEG; charset=binary' } })
    const cache = createSoundboardCache({ dir, request: http.request })
    expect(await cache.fetchSoundboardSound('9')).toBe(path.join(dir, '9.mp3'))
  })

  it('キャッシュにあれば取りに行かず、最終使用時刻を更新する', async () => {
    const file = path.join(dir, '55.mp3')
    fs.writeFileSync(file, Buffer.from([9]))
    const old = new Date(Date.now() - 3_600_000)
    fs.utimesSync(file, old, old)
    const http = fakeRequest({})
    const cache = createSoundboardCache({ dir, request: http.request })
    expect(await cache.fetchSoundboardSound('55')).toBe(file)
    expect(http.urls).toEqual([])
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + 60_000)
  })

  it('形の違う ID は通信せずに断る', async () => {
    const http = fakeRequest({})
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('../x')).rejects.toThrow('サウンド ID')
    expect(http.urls).toEqual([])
  })

  it('200 以外は失敗にし、ファイルを残さない', async () => {
    const http = fakeRequest({ status: 404 })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('404')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('リダイレクトは追わずに失敗にする', async () => {
    const http = fakeRequest({ status: 302, headers: { location: 'https://evil.example/x' } })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('リダイレクト')
    expect(http.urls).toHaveLength(1)
  })

  it('音声でない Content-Type は失敗にする', async () => {
    for (const ct of ['text/html', 'audio/wav', undefined]) {
      const http = fakeRequest({ headers: { 'content-type': ct } })
      const cache = createSoundboardCache({ dir, request: http.request })
      await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('音声ではありません')
    }
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('Content-Length が上限を超えていたら読まずに打ち切る', async () => {
    const http = fakeRequest({
      headers: { 'content-type': 'audio/ogg', 'content-length': String(SOUNDBOARD_MAX_BYTES + 1) }
    })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('大きすぎ')
    expect(http.aborted()).toBeGreaterThan(0)
  })

  it('受信中に上限を超えたら打ち切り、ファイルを残さない', async () => {
    const big = new Uint8Array(1024 * 1024)
    const http = fakeRequest({ chunks: Array.from({ length: 9 }, () => big) })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('大きすぎ')
    expect(http.aborted()).toBeGreaterThan(0)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('応答が来なければ時間切れで失敗にする', async () => {
    const http = fakeRequest({ hang: true })
    const cache = createSoundboardCache({ dir, request: http.request, timeoutMs: 20 })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('時間切れ')
    expect(http.aborted()).toBeGreaterThan(0)
  })

  it('同じ ID を同時に求められても 1 回だけ取りに行く', async () => {
    const http = fakeRequest({})
    const cache = createSoundboardCache({ dir, request: http.request })
    const [a, b] = await Promise.all([cache.fetchSoundboardSound('7'), cache.fetchSoundboardSound('7')])
    expect(a).toBe(b)
    expect(http.urls).toHaveLength(1)
  })

  it('空の応答は失敗にし、保存しない', async () => {
    const http = fakeRequest({ chunks: [] })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('空')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('Content-Length と受信量が合わなければ（途中で切れた）失敗にし、保存しない', async () => {
    const http = fakeRequest({
      headers: { 'content-type': 'audio/ogg', 'content-length': '10' },
      chunks: [new Uint8Array(4)]
    })
    const cache = createSoundboardCache({ dir, request: http.request })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('途中で切れ')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('受信の途中で時間切れになったら、その後は読み続けず保存もしない', async () => {
    const http = fakeRequest({
      chunks: [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)],
      chunkDelayMs: 15
    })
    const cache = createSoundboardCache({ dir, request: http.request, timeoutMs: 25 })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('時間切れ')
    const readsAtTimeout = http.reads()
    await sleep(100)
    // 時間切れの時点で待っていた 1 チャンクは届きうるが、そこで打ち切る
    expect(http.reads()).toBeLessThanOrEqual(readsAtTimeout + 1)
    expect(http.reads()).toBeLessThan(4)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('signal を見ない実装でも、時間切れの後に届いた応答は読まずに閉じる', async () => {
    const http = fakeRequest({ responseDelayMs: 40 })
    const cache = createSoundboardCache({ dir, request: http.request, timeoutMs: 10 })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('時間切れ')
    const abortedAtTimeout = http.aborted()
    await sleep(80)
    expect(http.reads()).toBe(0)
    expect(http.aborted()).toBeGreaterThan(abortedAtTimeout)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('書き込みに失敗したら一時ファイルを残さない', async () => {
    const broken = {
      ...fs,
      writeFileSync: (p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
        fs.writeFileSync(p, data)
        throw new Error('ディスクがいっぱい')
      }
    } as typeof fs
    const cache = createSoundboardCache({ dir, request: fakeRequest({}).request, fs: broken })
    await expect(cache.fetchSoundboardSound('1')).rejects.toThrow('ディスクがいっぱい')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('置き換えに失敗したら一時ファイルを消し、別のプロセスが置いたものがあればそれを使う', async () => {
    const renameFails = (other: boolean): typeof fs =>
      ({
        ...fs,
        renameSync: () => {
          // Stable と Canary が同時に同じ ID を取り、相手が先に置いて開いている状況
          if (other) fs.writeFileSync(path.join(dir, '1.ogg'), 'x')
          throw new Error('EPERM')
        }
      }) as typeof fs
    const failing = createSoundboardCache({ dir, request: fakeRequest({}).request, fs: renameFails(false) })
    await expect(failing.fetchSoundboardSound('1')).rejects.toThrow('EPERM')
    expect(fs.readdirSync(dir)).toEqual([])

    const shared = createSoundboardCache({ dir, request: fakeRequest({}).request, fs: renameFails(true) })
    expect(await shared.fetchSoundboardSound('1')).toBe(path.join(dir, '1.ogg'))
    expect(fs.readdirSync(dir)).toEqual(['1.ogg'])
  })

  it(`別の ID の同時取得は ${SOUNDBOARD_MAX_CONCURRENT} 本までにし、超えた分は待たせる`, async () => {
    const urls: string[] = []
    const release: Array<() => void> = []
    const request = (url: string): Promise<SoundboardHttpResponse> =>
      new Promise((resolve) => {
        urls.push(url)
        release.push(() =>
          resolve({
            status: 200,
            headers: { 'content-type': 'audio/ogg' },
            body: (async function* () {
              yield new Uint8Array([1])
            })(),
            abort: () => undefined
          })
        )
      })
    const cache = createSoundboardCache({ dir, request })
    const jobs = ['1', '2', '3', '4', '5'].map((id) => cache.fetchSoundboardSound(id))
    await sleep(10)
    expect(urls).toHaveLength(SOUNDBOARD_MAX_CONCURRENT)
    release[0]!()
    await sleep(10)
    expect(urls).toHaveLength(SOUNDBOARD_MAX_CONCURRENT + 1)
    for (let i = 1; i < 5; i++) {
      release[i]?.()
      await sleep(10)
    }
    expect(await Promise.all(jobs)).toHaveLength(5)
    expect(urls).toHaveLength(5)
  })

  it('上限の掃除のついでに、5 分以上前の書きかけの一時ファイルを消す', async () => {
    const old = new Date(Date.now() - 6 * 60_000)
    const staleTmp = path.join(dir, '9.ogg.123-1.tmp')
    const freshTmp = path.join(dir, '8.ogg.123-2.tmp')
    const otherOld = path.join(dir, 'keep.tmp')
    for (const f of [staleTmp, freshTmp, otherOld]) fs.writeFileSync(f, 'x')
    fs.utimesSync(staleTmp, old, old)
    fs.utimesSync(otherOld, old, old)
    const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
    await cache.fetchSoundboardSound('1')
    expect(fs.readdirSync(dir).sort()).toEqual(['1.ogg', '8.ogg.123-2.tmp', 'keep.tmp'])
  })

  it('件数の上限を超えたら、最終使用が古いものから消す（今取ったものは残す）', async () => {
    const base = Date.now() - 10_000_000
    for (let i = 1; i <= 3; i++) {
      const f = path.join(dir, `${i}.ogg`)
      fs.writeFileSync(f, Buffer.from([i]))
      fs.utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000))
    }
    // 無関係なファイルは数えず、消さない
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
    const http = fakeRequest({})
    const cache = createSoundboardCache({ dir, request: http.request, maxFiles: 3 })
    await cache.fetchSoundboardSound('4')
    expect(fs.readdirSync(dir).sort()).toEqual(['2.ogg', '3.ogg', '4.ogg', 'note.txt'])
  })

  it('合計サイズの上限を超えたら、古いものから消す', async () => {
    const base = Date.now() - 10_000_000
    for (let i = 1; i <= 2; i++) {
      const f = path.join(dir, `${i}.ogg`)
      fs.writeFileSync(f, Buffer.alloc(10))
      fs.utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000))
    }
    const http = fakeRequest({ chunks: [new Uint8Array(10)] })
    const cache = createSoundboardCache({ dir, request: http.request, maxTotalBytes: 25 })
    await cache.fetchSoundboardSound('3')
    expect(fs.readdirSync(dir).sort()).toEqual(['2.ogg', '3.ogg'])
  })
})

describe('resolveCachedSoundPath', () => {
  it('キャッシュ先直下の <id>.ogg / <id>.mp3 の実ファイルだけ実パスを返す', () => {
    fs.writeFileSync(path.join(dir, '12.ogg'), 'x')
    fs.writeFileSync(path.join(dir, '13.mp3'), 'x')
    const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
    expect(cache.resolveCachedSoundPath(path.join(dir, '12.ogg'))).toBe(fs.realpathSync(path.join(dir, '12.ogg')))
    expect(cache.resolveCachedSoundPath(path.join(dir, '13.mp3'))).toBe(fs.realpathSync(path.join(dir, '13.mp3')))
  })

  it('名前・場所・種類が違うもの、トラバーサル、相対パスは null', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-soundboard-out-'))
    try {
      fs.writeFileSync(path.join(outside, '1.ogg'), 'x')
      fs.writeFileSync(path.join(dir, 'a.ogg'), 'x')
      fs.writeFileSync(path.join(dir, '1.wav'), 'x')
      fs.mkdirSync(path.join(dir, 'sub'))
      fs.writeFileSync(path.join(dir, 'sub', '2.ogg'), 'x')
      fs.mkdirSync(path.join(dir, '3.ogg'))
      const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
      const rel = path.relative(dir, path.join(outside, '1.ogg'))
      for (const p of [
        path.join(outside, '1.ogg'),
        path.join(dir, rel),
        `${dir}${path.sep}..${path.sep}${path.basename(outside)}${path.sep}1.ogg`,
        path.join(dir, 'a.ogg'),
        path.join(dir, '1.wav'),
        path.join(dir, 'sub', '2.ogg'),
        path.join(dir, '3.ogg'),
        path.join(dir, '404.ogg'),
        '1.ogg',
        '',
        `${path.join(dir, '1.ogg')}\0`
      ]) {
        expect(cache.resolveCachedSoundPath(p)).toBeNull()
      }
      expect(cache.resolveCachedSoundPath(42 as unknown as string)).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('キャッシュ先の中のジャンクションを通して外のファイルを読ませない', () => {
    withOutside((outside) => {
      fs.writeFileSync(path.join(outside, '1.ogg'), 'x')
      fs.symlinkSync(outside, path.join(dir, 'j'), 'junction')
      const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
      expect(cache.resolveCachedSoundPath(path.join(dir, 'j', '1.ogg'))).toBeNull()
    })
  })

  it('キャッシュ先を指すジャンクション経由のパスも、ジャンクションに差し替えられたキャッシュ先も拒否する', () => {
    withOutside((outside) => {
      fs.writeFileSync(path.join(dir, '1.ogg'), 'x')
      // 外からキャッシュ先を指す別名
      const alias = path.join(outside, 'alias')
      fs.symlinkSync(dir, alias, 'junction')
      const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
      expect(cache.resolveCachedSoundPath(path.join(alias, '1.ogg'))).toBeNull()

      // キャッシュ先そのものがジャンクションで、別の場所を指している
      const target = path.join(outside, 'target')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, '2.ogg'), 'x')
      const swapped = path.join(outside, 'soundboard')
      fs.symlinkSync(target, swapped, 'junction')
      const swappedCache = createSoundboardCache({ dir: swapped, request: fakeRequest({}).request })
      expect(swappedCache.resolveCachedSoundPath(path.join(swapped, '2.ogg'))).toBeNull()
    })
  })

  it('キャッシュ先に置かれたシンボリックリンクで外のファイルを読ませない', (ctx) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-soundboard-out-'))
    try {
      const target = path.join(outside, 'secret.ogg')
      fs.writeFileSync(target, 'x')
      try {
        fs.symlinkSync(target, path.join(dir, '5.ogg'), 'file')
      } catch {
        // Windows で開発者モードでないと作れない。作れない環境では確かめようがない
        ctx.skip()
      }
      const cache = createSoundboardCache({ dir, request: fakeRequest({}).request })
      expect(cache.resolveCachedSoundPath(path.join(dir, '5.ogg'))).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('resolveReadableSoundPath', () => {
  it('設定 ON ならキャッシュのファイルを先に通し、フォルダ内は従来どおり、フォルダ外はキャッシュ名に似ていても従来のエラー', () => {
    withOutside((outside) => {
      const folder = path.join(outside, 'sounds')
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, 'a.wav'), 'x')
      fs.writeFileSync(path.join(dir, '1.ogg'), 'x')
      fs.writeFileSync(path.join(outside, '2.ogg'), 'x')
      const soundboard = createSoundboardCache({ dir, request: fakeRequest({}).request })
      const read = (requested: string): string =>
        resolveReadableSoundPath({ soundboard, unlocked: true, soundsFs: realSoundsFs, folder, requested })

      expect(read(path.join(dir, '1.ogg'))).toBe(fs.realpathSync(path.join(dir, '1.ogg')))
      expect(read(path.join(folder, 'a.wav'))).toBe(fs.realpathSync(path.join(folder, 'a.wav')))
      expect(() => read(path.join(outside, '2.ogg'))).toThrow('音源フォルダの外は読み取れません')
    })
  })

  it('設定 OFF ならキャッシュのファイルも読ませない', () => {
    withOutside((outside) => {
      fs.writeFileSync(path.join(dir, '1.ogg'), 'x')
      const soundboard = createSoundboardCache({ dir, request: fakeRequest({}).request })
      expect(() =>
        resolveReadableSoundPath({
          soundboard,
          unlocked: false,
          soundsFs: realSoundsFs,
          folder: outside,
          requested: path.join(dir, '1.ogg')
        })
      ).toThrow('音源フォルダの外は読み取れません')
    })
  })
})
