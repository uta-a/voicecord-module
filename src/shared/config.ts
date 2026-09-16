import { REF_MAX_DBFS, REF_MIN_DBFS } from './loudness.js'
import type { AppConfig } from './types.js'

/**
 * 設定の永続化。
 *
 * 移植元（VoiceCord/desktop/src/main/config.ts）から、実事故から生まれた 3 つの
 * 耐性をそのまま持ち込む。
 *
 *   1. BOM を落としてから parse する。Windows のメモ帳や PowerShell の
 *      `Set-Content -Encoding utf8` は UTF-8 BOM を付けるので、ユーザーが設定を
 *      手で覗いて保存し直しただけで JSON.parse が落ちる。落ちると既定値で動き出し、
 *      次の保存で校正値と音源別音量ごと上書きされる ＝ 手編集しただけで設定が消える。
 *   2. 読めなかったファイルは `.broken` へ退避してから既定値で始める。退避しないと
 *      直後の保存で上書きされ、目で読めば救えたはずの中身が消える。
 *   3. tmp へ書いてから rename する。直接上書きは、書き込み途中で落ちると
 *      壊れた JSON を残し、次回起動で通知なく全設定が既定へ戻る。
 *
 * 移植元との違いは electron に依存しないこと。userData ではなく
 * %LOCALAPPDATA%\VoiceCord（paths.ts）に置き、fs は注入する。
 */

/** 旧 Electron アプリ（%APPDATA%\voicecord）からの移行結果 */
export interface ConfigLoad {
  config: AppConfig
  /** 読み込みに失敗した理由。null なら正常。UI に一度だけ出す */
  warning: string | null
  /** 旧設定から引き継いだ場合の元パス。無言で移行しない */
  migratedFrom: string | null
}

/**
 * 注入する fs。config は utf8 のテキストしか扱わないので、fsLike の
 * Buffer 併用シグネチャは使わずここで絞る（テスト側の型合わせが楽になる）。
 * node の fs はこの形に代入できる。
 */
export interface ConfigFs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string, enc: 'utf8'): void
  renameSync(from: string, to: string): void
  unlinkSync(p: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
}

/**
 * 音源フォルダの既定値。
 *
 * 移植元は repoRoot/sounds だったが、mod には repoRoot が無い。
 * VC に参加していないと UI が出ない構成（M4.5 の判断 3）なので、
 * 初回に選ばせる導線が作れない。既定を決め打ちして自動作成する。
 */
export function defaultSoundsFolder(userProfile: string, join: (...p: string[]) => string): string {
  return join(userProfile, 'Documents', 'VoiceCord', 'sounds')
}

export function defaultConfig(soundsFolder: string): AppConfig {
  return {
    build: 'canary',
    folder: soundsFolder,
    master: 0.8,
    sidetoneEnabled: false,
    sidetoneDevice: '',
    sidetoneVolume: 0.7,
    sourceVolumes: {},
    entrySoundEnabled: false,
    entrySoundSrcId: '',
    entrySoundVolume: 1.0,
    entryDelayMs: 0,
    entryLeaveDebounceMs: 2500,
    normalizeRefDbfs: -14,
    hideCameraButton: true,
    unlockSoundboard: false,
    calibration: null
  }
}

/**
 * 数値設定の範囲。config.json は手編集できるので、壊れた値（NaN・文字列・範囲外）が
 * そのまま hook.js まで流れないよう読み込み時に矯正する。hook.js 側にも同じガードが
 * あるが、UI の表示値を正せるのはここだけ。
 */
const RANGES: Record<string, [number, number]> = {
  master: [0, 4],
  sidetoneVolume: [0, 1],
  entrySoundVolume: [0, 1.5],
  entryDelayMs: [0, 10_000],
  entryLeaveDebounceMs: [0, 60_000],
  normalizeRefDbfs: [REF_MIN_DBFS, REF_MAX_DBFS]
}

/** 音源別音量の上限。UI のスライダー（0〜150%）と揃える */
const SOURCE_VOLUME_MAX = 1.5

export function sanitize(data: AppConfig, dflt: AppConfig): AppConfig {
  const rec = data as unknown as Record<string, unknown>
  const dfltRec = dflt as unknown as Record<string, unknown>
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const n = Number(rec[key])
    if (!Number.isFinite(n)) rec[key] = dfltRec[key]
    else rec[key] = Math.min(max, Math.max(min, n))
  }
  // 音源別音量は任意のキーを持つので個別に走査する
  const sv = rec['sourceVolumes']
  if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
    const out: Record<string, number> = {}
    for (const [id, v] of Object.entries(sv as Record<string, unknown>)) {
      const n = Number(v)
      if (Number.isFinite(n)) out[id] = Math.min(SOURCE_VOLUME_MAX, Math.max(0, n))
    }
    rec['sourceVolumes'] = out
  } else {
    rec['sourceVolumes'] = {}
  }
  // 手編集で真偽値以外が入っていたら既定へ(文字列の "false" を真と扱わない)
  if (typeof rec['hideCameraButton'] !== 'boolean') rec['hideCameraButton'] = dfltRec['hideCameraButton']
  if (typeof rec['unlockSoundboard'] !== 'boolean') rec['unlockSoundboard'] = dfltRec['unlockSoundboard']
  // folder は文字列でなければ既定へ。空文字は「未設定」として既定に戻す
  if (typeof rec['folder'] !== 'string' || rec['folder'] === '') rec['folder'] = dfltRec['folder']
  return data
}

/** config.json のテキストを AppConfig へ。読み取り側の耐性はここに集約する（純関数） */
export function parseConfigText(
  text: string,
  dflt: AppConfig
): { config: AppConfig; error: string | null } {
  try {
    const loaded = JSON.parse(stripBom(text)) as Partial<AppConfig>
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return { config: dflt, error: '設定ファイルの形式が想定と違いました' }
    }
    return { config: sanitize({ ...dflt, ...loaded }, dflt), error: null }
  } catch (e) {
    return { config: dflt, error: `設定ファイルを読み取れませんでした: ${String(e)}` }
  }
}

/** UTF-8 BOM（U+FEFF）を落とす。付いたまま JSON.parse すると落ちる */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 設定を読む。書き込みはしない（移行の書き出しは呼び出し側が決める）。
 *
 * 現行 → 無ければ旧 Electron アプリの config を読む。旧ファイルは消さない。
 */
export function loadConfig(
  fs: ConfigFs,
  paths: { config: string; legacyConfig: string },
  dflt: AppConfig
): ConfigLoad {
  const src = pickSource(fs, paths)
  if (src === null) return { config: dflt, warning: null, migratedFrom: null }

  let text: string
  try {
    text = fs.readFileSync(src, 'utf8')
  } catch (e) {
    return {
      config: dflt,
      warning: `設定ファイルを開けませんでした: ${String(e)}`,
      migratedFrom: null
    }
  }

  const { config, error } = parseConfigText(text, dflt)
  if (error !== null) {
    const kept = keepBroken(fs, src)
    return {
      config: dflt,
      warning:
        error +
        (kept !== null
          ? `。設定は初期値に戻りました。元のファイルは ${kept} に残してあります`
          : '。設定は初期値に戻りました'),
      migratedFrom: null
    }
  }

  return {
    config,
    warning: null,
    migratedFrom: src === paths.config ? null : src
  }
}

function pickSource(
  fs: ConfigFs,
  paths: { config: string; legacyConfig: string }
): string | null {
  if (fs.existsSync(paths.config)) return paths.config
  if (fs.existsSync(paths.legacyConfig)) return paths.legacyConfig
  return null
}

/** 読めなかったファイルを退避する。失敗しても致命ではないので null を返して続ける */
function keepBroken(fs: ConfigFs, src: string): string | null {
  try {
    const kept = `${src}.broken`
    fs.renameSync(src, kept)
    return kept
  } catch {
    return null
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * 設定を書く。tmp へ書いてから rename する（同一ボリューム上なので原子的）。
 *
 * 拡張子を .json.tmp にしない。config.json.tmp が残っていても実害は無いが、
 * 読み込み側は config.json しか見ないので、中途半端な内容が読まれることはない。
 */
export function saveConfigFile(
  fs: ConfigFs,
  configPath: string,
  data: AppConfig,
  dirname: (p: string) => string
): SaveResult {
  const tmp = `${configPath}.tmp`
  try {
    fs.mkdirSync(dirname(configPath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, configPath)
    return { ok: true }
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      // 消せなくても構わない。次の保存で上書きされる
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ConfigStore {
  get(): AppConfig
  /** 部分更新して保存する。保存に失敗しても在庫の値は更新する（UI を固まらせない） */
  save(partial: Partial<AppConfig>): SaveResult
  /** 起動時に一度だけ UI へ出す警告。読めなかった理由や移行の報告 */
  readonly loadWarning: string | null
}

/**
 * 読み込み・移行・保存をまとめる。
 *
 * 旧設定から引き継いだ場合はその場で新しい場所へ書き出し、以後そちらを使う。
 * **旧ファイルは消さない**。そして移行したことを必ず warning に出す
 * （無言で移行すると、ユーザーは旧ファイルを消してよいのか判断できない）。
 */
export function createConfigStore(
  fs: ConfigFs,
  paths: { config: string; legacyConfig: string },
  dflt: AppConfig,
  dirname: (p: string) => string
): ConfigStore {
  const loaded = loadConfig(fs, paths, dflt)
  let data = loaded.config
  const notes: string[] = []
  if (loaded.warning !== null) notes.push(loaded.warning)

  if (loaded.migratedFrom !== null) {
    const r = saveConfigFile(fs, paths.config, data, dirname)
    notes.push(
      r.ok
        ? `以前の設定を ${loaded.migratedFrom} から引き継ぎました（元のファイルはそのまま残してあります）`
        : `以前の設定を ${loaded.migratedFrom} から読みましたが、新しい場所へ保存できませんでした: ${r.error}`
    )
  }

  return {
    get: () => data,
    save: (partial) => {
      data = { ...data, ...partial }
      return saveConfigFile(fs, paths.config, data, dirname)
    },
    loadWarning: notes.length > 0 ? notes.join('\n') : null
  }
}
