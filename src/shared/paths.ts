/**
 * VoiceCord のランタイム配置。
 *
 * %APPDATA%\VoiceCord ではなく %LOCALAPPDATA%\VoiceCord を使う。Windows は
 * ファイル名の大文字小文字を区別しないので、%APPDATA%\VoiceCord は旧 Electron
 * アプリの userData だった %APPDATA%\voicecord と同一ディレクトリになってしまう。
 * そこには Cache / GPUCache / Local Storage が同居していて、ユーザーが
 * 「旧アプリの設定フォルダを消す」と mod のペイロードごと消える。
 * ついでに 75MB の frida バイナリをローミングプロファイルに載せずに済む。
 *
 * ディレクトリ名を固定にしているのは、AV の除外パスがバージョンで動かないようにするため。
 */

export interface PathEnv {
  /** %LOCALAPPDATA% */
  localAppData: string
  /** %APPDATA%（旧設定の移行元を探すためだけに使う） */
  appData: string
}

export interface VoiceCordPaths {
  /** %LOCALAPPDATA%\VoiceCord */
  root: string
  /** ペイロード一式。shim はここの patcher.js を require する */
  dist: string
  patcher: string
  preload: string
  /** frida エージェント */
  hook: string
  /** utilityProcess の子として起動するエンジン */
  engine: string
  config: string
  /** パッチ状態の記録。ユーザー設定ではないので config とは分ける */
  state: string
  restoreNote: string
  /** 旧 Electron アプリの設定。移行元として一度だけ読む */
  legacyConfig: string
}

export function voiceCordPaths(env: PathEnv, join: (...p: string[]) => string): VoiceCordPaths {
  const root = join(env.localAppData, 'VoiceCord')
  const dist = join(root, 'dist')
  return {
    root,
    dist,
    patcher: join(dist, 'patcher.js'),
    preload: join(dist, 'preload.js'),
    hook: join(dist, 'hook.js'),
    engine: join(dist, 'engine.mjs'),
    config: join(root, 'config.json'),
    state: join(root, 'state.json'),
    restoreNote: join(root, '復旧手順.txt'),
    legacyConfig: join(env.appData, 'voicecord', 'config.json')
  }
}

/** 実行環境から組み立てる。環境変数が無ければ throw する（黙って別の場所に書かない）。 */
export function voiceCordPathsFromEnv(
  env: NodeJS.ProcessEnv,
  join: (...p: string[]) => string
): VoiceCordPaths {
  const localAppData = env['LOCALAPPDATA']
  const appData = env['APPDATA']
  if (!localAppData) throw new Error('LOCALAPPDATA が設定されていません')
  if (!appData) throw new Error('APPDATA が設定されていません')
  return voiceCordPaths({ localAppData, appData }, join)
}
