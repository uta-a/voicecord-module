import nodeFs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { isSoundboardSoundId } from '../shared/soundboard.js'
import { resolveSoundPath, type SoundsFs } from './soundsFs.js'

export { isSoundboardSoundId }

/**
 * ほかのサーバーのサウンドボード音声を Discord の CDN から取り、一時フォルダに置く。
 *
 * renderer は生ファイルを readSoundFile で読むので、取ってきた音声もファイルとして置き、
 * 既存の再生経路（pcmAt → decode → engine）へそのまま流す。
 *
 * 外から取ったものを書き、それを renderer に読ませる経路なので、関門を固定する。
 *   - 取りに行くのは cdn.discordapp.com の決まったパスだけ。ID は数字だけ
 *   - リダイレクトは追わない（行き先を CDN の外へ変えられない）
 *   - 形式は ogg / mp3、大きさは 8MB まで。超えたら受信の途中でも打ち切る。空や途中で切れたものは置かない
 *   - 読ませるのはキャッシュ先直下の `<id>.ogg|mp3` の実ファイルだけ（realpath で確かめる）
 *
 * キャッシュ先は Stable と Canary が同時に動いていても共有する（%TEMP% はユーザーごとに 1 つ）。
 */

export const SOUNDBOARD_CDN_HOST = 'cdn.discordapp.com'
export const SOUNDBOARD_MAX_BYTES = 8 * 1024 * 1024
export const SOUNDBOARD_TIMEOUT_MS = 10_000
/** 一時フォルダに溜め続けないための上限。超えたら最終使用が古い順に消す */
export const SOUNDBOARD_MAX_FILES = 200
export const SOUNDBOARD_MAX_TOTAL_BYTES = 100 * 1024 * 1024
/** 別の ID の同時取得の上限。連打で CDN へ一斉に取りに行かない */
export const SOUNDBOARD_MAX_CONCURRENT = 3
/** これより古い書きかけの一時ファイルは、落ちたプロセスの残骸とみなして消す */
export const SOUNDBOARD_STALE_TMP_MS = 5 * 60_000

const CACHED_NAME_RE = /^\d{1,20}\.(ogg|mp3)$/
/** download が書く一時ファイルの名前（`<id>.<ext>.<pid>-<seq>.tmp`） */
const TMP_NAME_RE = /^\d{1,20}\.(ogg|mp3)\.\d+-\d+\.tmp$/
const EXT_BY_TYPE: Record<string, 'ogg' | 'mp3'> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3'
}

export interface SoundboardHttpResponse {
  status: number
  /** キーは小文字 */
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  /** 受信を打ち切る */
  abort: () => void
}

export type SoundboardRequest = (url: string, signal: AbortSignal) => Promise<SoundboardHttpResponse>

export interface SoundboardCacheDeps {
  dir?: string
  request?: SoundboardRequest
  fs?: typeof nodeFs
  timeoutMs?: number
  maxBytes?: number
  maxFiles?: number
  maxTotalBytes?: number
}

export interface SoundboardCache {
  /** 取得（キャッシュにあればそれ）して実パスを返す。失敗は理由つきで throw */
  fetchSoundboardSound: (id: string) => Promise<string>
  /** キャッシュ先直下の正しい名前の実ファイルなら実パス、それ以外は null */
  resolveCachedSoundPath: (requested: string) => string | null
}

export function defaultSoundboardCacheDir(): string {
  return path.join(os.tmpdir(), 'VoiceCord', 'soundboard')
}

/**
 * Node 標準の https で GET する。https.get はリダイレクトを追わないので、3xx はそのまま返る。
 * Electron の net.fetch は既定でリダイレクトを追い、Chromium のプロキシやキャッシュも挟むので使わない。
 */
export const httpsRequest: SoundboardRequest = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { signal }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        abort: () => res.destroy()
      })
    })
    req.on('error', reject)
  })

const headerOf = (headers: SoundboardHttpResponse['headers'], name: string): string | undefined => {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Received {
  bytes: Buffer
  ext: 'ogg' | 'mp3'
}

export function createSoundboardCache(deps: SoundboardCacheDeps = {}): SoundboardCache {
  const dir = deps.dir ?? defaultSoundboardCacheDir()
  const request = deps.request ?? httpsRequest
  const fs = deps.fs ?? nodeFs
  const timeoutMs = deps.timeoutMs ?? SOUNDBOARD_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? SOUNDBOARD_MAX_BYTES
  const maxFiles = deps.maxFiles ?? SOUNDBOARD_MAX_FILES
  const maxTotalBytes = deps.maxTotalBytes ?? SOUNDBOARD_MAX_TOTAL_BYTES

  /** 同じ ID の連打で同じファイルを何本も取りに行かない（一時ファイルの rename も競合させない） */
  const inflight = new Map<string, Promise<string>>()
  let tmpSeq = 0

  // 別の ID の同時取得の枠。空くのを待つ間は時間切れを数えない（待ち時間で失敗させない）
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (active < SOUNDBOARD_MAX_CONCURRENT) {
      active += 1
      return
    }
    // 空いた枠は release がそのまま譲る（active は減らさない）
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }

  const cachedPath = (id: string): string | null => {
    for (const ext of ['ogg', 'mp3']) {
      const p = path.join(dir, `${id}.${ext}`)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {
        // 無ければ次の拡張子
      }
    }
    return null
  }

  /**
   * 上限を超えたぶんを最終使用（mtime）が古い順に消す。ついでに古い書きかけの一時ファイルも消す。
   * 消せなくても再生は止めない
   */
  const evict = (keep: string): void => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    const staleBefore = Date.now() - SOUNDBOARD_STALE_TMP_MS
    const entries: Array<{ p: string; mtime: number; size: number }> = []
    for (const name of names) {
      const cached = CACHED_NAME_RE.test(name)
      const tmp = TMP_NAME_RE.test(name)
      if (!cached && !tmp) continue
      const p = path.join(dir, name)
      try {
        const st = fs.statSync(p)
        if (!st.isFile()) continue
        if (cached) entries.push({ p, mtime: st.mtimeMs, size: st.size })
        // 新しい一時ファイルは別のプロセスが書いている最中かもしれないので残す
        else if (st.mtimeMs < staleBefore) fs.unlinkSync(p)
      } catch {
        // 読めない・消せないものは次回に回す
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    let count = entries.length
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    for (const e of entries) {
      if (count <= maxFiles && total <= maxTotalBytes) break
      if (e.p === keep) continue
      try {
        fs.unlinkSync(e.p)
        count -= 1
        total -= e.size
      } catch {
        // 使用中などで消せなければ次回に回す
      }
    }
  }

  /** CDN から受け取る。応答待ちも受信中も含めて時間を切る */
  const receive = async (id: string): Promise<Received> => {
    const ac = new AbortController()
    let res: SoundboardHttpResponse | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutError = (): Error => new Error(`時間切れです（${Math.round(timeoutMs / 1000)} 秒）`)
    // signal を見ない実装でも止まるよう race にする。race が決着した後も work は走りうるので、
    // work 側でも節目ごとに aborted を見て、読み続けない
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        res?.abort()
        reject(timeoutError())
      }, timeoutMs)
    })
    const work = async (): Promise<Received> => {
      const url = `https://${SOUNDBOARD_CDN_HOST}/soundboard-sounds/${id}`
      const r = await request(url, ac.signal)
      res = r
      if (ac.signal.aborted) {
        r.abort()
        throw timeoutError()
      }
      if (r.status >= 300 && r.status < 400) {
        r.abort()
        throw new Error(`リダイレクトは追いません（HTTP ${r.status}）`)
      }
      if (r.status !== 200) {
        r.abort()
        throw new Error(`HTTP ${r.status}`)
      }
      const type = (headerOf(r.headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const ext = EXT_BY_TYPE[type]
      if (ext === undefined) {
        r.abort()
        throw new Error(`音声ではありません（${type || '種類不明'}）`)
      }
      const lengthHeader = headerOf(r.headers, 'content-length')
      const declared = lengthHeader === undefined || lengthHeader.trim() === '' ? null : Number(lengthHeader)
      if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
        r.abort()
        throw new Error(`大きすぎます（${declared} バイト）`)
      }
      const chunks: Uint8Array[] = []
      let received = 0
      for await (const chunk of r.body) {
        if (ac.signal.aborted) {
          r.abort()
          throw timeoutError()
        }
        received += chunk.byteLength
        // Content-Length は偽れるので、受信した実量でも打ち切る
        if (received > maxBytes) {
          r.abort()
          throw new Error(`大きすぎます（${maxBytes} バイト超）`)
        }
        chunks.push(chunk)
      }
      if (received === 0) throw new Error('空の応答です')
      // 接続が途中で切れても for await は正常に終わりうる。欠けた音声をキャッシュに残さない
      if (declared !== null && Number.isFinite(declared) && declared !== received) {
        throw new Error(`受信が途中で切れました（${received} / ${declared} バイト）`)
      }
      return { bytes: Buffer.concat(chunks), ext }
    }
    try {
      return await Promise.race([work(), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  /** 書きかけを読ませないよう、別名で書き切ってから置き換える */
  const store = (id: string, got: Received): string => {
    fs.mkdirSync(dir, { recursive: true })
    const final = path.join(dir, `${id}.${got.ext}`)
    const tmp = path.join(dir, `${id}.${got.ext}.${process.pid}-${++tmpSeq}.tmp`)
    try {
      fs.writeFileSync(tmp, got.bytes)
      fs.renameSync(tmp, final)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // 書けていなければ消す物も無い
      }
      // Stable と Canary が同時に同じ ID を取ると、先に置いた側が開いていて置き換えられないことがある。
      // 同じ ID の音声は同じなので、既に置かれていればそれを使う
      const other = cachedPath(id)
      if (other !== null) return other
      throw new Error(`キャッシュに保存できませんでした: ${message(e)}`)
    }
    evict(final)
    return final
  }

  const download = async (id: string): Promise<string> => {
    await acquire()
    let got: Received
    try {
      got = await receive(id)
    } finally {
      // 時間切れで決着したら、止まらない実装の後始末を待たずに枠を返す
      release()
    }
    return store(id, got)
  }

  const fetchSoundboardSound = (id: string): Promise<string> => {
    if (!isSoundboardSoundId(id)) return Promise.reject(new Error('サウンド ID の形が想定と違います'))
    const hit = cachedPath(id)
    if (hit !== null) {
      // 最終使用時刻として mtime を使う（上限を超えたときに古い順に消すため）
      try {
        const now = new Date()
        fs.utimesSync(hit, now, now)
      } catch {
        // 更新できなくても再生はできる
      }
      return Promise.resolve(hit)
    }
    const running = inflight.get(id)
    if (running) return running
    const job = download(id).finally(() => inflight.delete(id))
    inflight.set(id, job)
    return job
  }

  const resolveCachedSoundPath = (requested: string): string | null => {
    if (typeof requested !== 'string' || requested === '' || requested.includes('\0')) return null
    if (!path.isAbsolute(requested)) return null
    // 文字列の上でもキャッシュ先直下であること。キャッシュ先を指す別名（ジャンクション）経由は通さない
    if (!CACHED_NAME_RE.test(path.relative(path.resolve(dir), path.resolve(requested)))) return null
    try {
      // キャッシュ先そのものがリンク（ジャンクション）に差し替えられていたら、指す先を信用しない
      if (fs.lstatSync(dir).isSymbolicLink()) return null
    } catch {
      return null
    }
    let realDir: string
    let realTarget: string
    try {
      realDir = fs.realpathSync(dir)
      realTarget = fs.realpathSync(requested)
    } catch {
      return null
    }
    // 実体でも直下の正しい名前であること。ファイルのリンクで外を指していれば、ここに落ちる
    const rel = path.relative(realDir, realTarget)
    if (!CACHED_NAME_RE.test(rel)) return null
    try {
      if (!fs.statSync(realTarget).isFile()) return null
    } catch {
      return null
    }
    return realTarget
  }

  return { fetchSoundboardSound, resolveCachedSoundPath }
}

export interface ReadableSoundPathOptions {
  soundboard: Pick<SoundboardCache, 'resolveCachedSoundPath'>
  /** ほかのサーバーのサウンドを鳴らす設定。OFF ならキャッシュは読ませない */
  unlocked: boolean
  soundsFs: SoundsFs
  folder: string
  requested: string
}

/**
 * readSoundFile で読んでよい実パス。読めなければ理由つきで throw。
 *
 * 取得したサウンドボード音声はサウンドフォルダの外にある。設定 ON のときだけ、キャッシュ先直下の
 * 決まった名前の実ファイルを先に通し、それ以外は従来どおりサウンドフォルダで検証する
 * （キャッシュに当たらなかったときの失敗の理由は従来と同じにする）。
 */
export function resolveReadableSoundPath(opts: ReadableSoundPathOptions): string {
  if (opts.unlocked) {
    const cached = opts.soundboard.resolveCachedSoundPath(opts.requested)
    if (cached !== null) return cached
  }
  const r = resolveSoundPath(opts.soundsFs, opts.folder, opts.requested)
  if (!r.ok) throw new Error(r.error)
  return r.path
}
