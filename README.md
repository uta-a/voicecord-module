# VoiceCord

Discord の画面からローカルの効果音をボイスチャットへ流せる Windows 向けクライアント mod です。Discord 内にサウンドボードを追加し、Krisp の処理後の音声へ効果音を混ぜます。

VoiceCord Manager はパッチの適用と解除に使います。適用後は Discord 内で動作するため、Manager を常駐させる必要はありません。

> 非公式のクライアント改変ツールです。Discord の `app.asar` を差し替えるため、更新や適用失敗で Discord が起動しなくなる可能性があります。利用前に [復旧手順](docs/RESTORE.md) を確認してください。Discord の利用規約やアカウントへの影響も利用者自身で確認してください。

## 主な機能

- Discord の音声パネルから開くサウンドボード
- ローカル音源の検索、再生、全停止、端末内での試聴
- 音源ごとの音量調整と一括調整
- マイクの声を測定し、効果音との音量差を調整
- モニターの有効化、出力デバイスと音量の選択
- VC 参加時の入場サウンド
- Manager によるパッチの適用、再適用、解除
- 既に導入されている Vencord などの patcher を引き継ぐ連鎖読み込み

## 動作条件と検証範囲

- Windows x64 の Discord デスクトップ版が対象です。ブラウザ版では動作しません。
- 開発と実機検証の対象は **Discord Canary** です。Manager は Stable、PTB、Development も検出しますが、それらの動作を保証するものではありません。
- Discord の「設定 → 音声・ビデオ → ノイズ抑制」を **Krisp** にしてください。音声処理の検出にはマイクのミュート解除も必要です。
- Discord 内部の構造と Krisp に依存します。Discord の更新により再適用や実装の修正が必要になることがあります。
- 音声レート修正の最新の検証では、起動中 Discord の配置変更と受信音の人的確認は行っていません。検証条件は [開発・検証メモ](docs/DEV-NOTES.md) と [作業記録](docs/PROGRESS.md) を参照してください。

## 導入

配布物がある場合は [Releases](https://github.com/uta-a/voicecord-module/releases) の `VoiceCordManager-<version>.exe` を使います。手元で作成する場合は [開発](#開発) を参照してください。Manager はインストール不要の portable 形式です。

1. Discord を完全に終了します。ウィンドウを閉じるだけでなく、タスクトレイからも終了してください。
2. VoiceCord Manager を起動します。
3. 対象の Discord を確認し「適用」を押します。検証には Canary を使用してください。
4. Discord を起動して VC に参加します。
5. 音声パネルの VoiceCord ボタンからサウンドボードを開きます。

Discord が起動中の場合は「終了して適用」も使えます。ただし Discord が強制終了されるため、送信前のメッセージなど未保存の内容は失われます。

既に導入済みの mod は自動で引き継がれます。「連鎖に足す patcher」は追加の patcher を明示する場合だけ指定してください。

## 使い方

### 音源を追加する

既定の音源フォルダは次の場所です。

```text
%USERPROFILE%\Documents\VoiceCord\sounds
```

音声ファイルをフォルダの直下に置き、パネルの「サウンド一覧を再読込」を押します。サブフォルダの音源は走査しません。別の場所を使う場合は「サウンドフォルダを選択」から変更できます。

一覧のタイルを押すと VC へ再生します。試聴は端末内だけで再生し、VC には送信しません。音源の右クリックからも試聴と個別音量の調整ができます。

一覧に表示する拡張子は `.wav`、`.mp3`、`.ogg`、`.flac`、`.m4a`、`.aac`、`.opus`、`.wma`、`.aiff`、`.f32` です。ただし実際に再生できる形式は Discord に組み込まれた Web Audio のデコーダに依存します。**一覧に出ることは再生の保証ではありません。** `.wma` は実機検証でデコードに失敗しています。

`.f32` はヘッダーなしの **48 kHz / モノラル / float32 little-endian** が入力条件です。別レートの raw PCM はレート情報を持つ WAV などへ変換してください。

### 音量を調整する

1. パネルの設定から「音量を調整」または「音量調整を開く」を選びます。
2. まず音源の音量を測り、必要な音源へ推奨音量を適用します。
3. VC に接続してミュートを解除し「声を測る」で声の大きさを測定します。
4. 希望する「声との差」を選び、設定を適用します。
5. 相手側で声とのバランスと音割れを確認します。

「すべての音源に音量を適用」は手動で調整済みの個別音量も上書きします。モニター音量は自分の端末の試聴とモニターだけに効き、相手に届く音量は変わりません。

## 更新・解除・復旧

- **Discord 更新後にボタンが消えた**: Manager で対象の Discord に「再適用」してください。
- **VoiceCord だけ外したい**: Discord を終了し、Manager の「VoiceCord だけ外す」を使います。
- **他の mod も含めて外したい**: 「素の Discord に戻す」を使います。Vencord なども同時に外れます。
- **Discord が起動しない**: [手作業での復旧手順](docs/RESTORE.md) に従ってください。Manager が起動できなくても復旧できます。
- **「VC待機中」のまま音が出ない**: VC への参加、ノイズ抑制の Krisp 設定、マイクのミュート解除を確認してください。パネルの状態表示も確認してください。

## 保存先

| 場所 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\VoiceCord\dist` | Discord 内で動かすペイロードと Frida ランタイム |
| `%LOCALAPPDATA%\VoiceCord\config.json` | 音源フォルダ、音量、入場サウンドなどの設定 |
| `%LOCALAPPDATA%\VoiceCord\state.json` | パッチ状態の記録 |
| `%LOCALAPPDATA%\VoiceCord\復旧手順.txt` | Manager が配置する復旧手順 |

旧アプリの `%APPDATA%\voicecord\config.json` は設定移行元です。現行版の保存先とは異なります。パッチを解除する前に `dist` を削除しないでください。Discord 側の shim がこの場所を参照します。

## 開発

Windows x64 と Node.js / npm が必要です。依存パッケージの Node.js 要件を満たすバージョンを使用してください。README 作成時のビルド確認環境は Node.js 24.18.0 / npm 11.18.0 です。

```powershell
git clone https://github.com/uta-a/voicecord-module.git
cd voicecord-module
npm ci
npm run build
npm run manager
```

`npm run manager` はビルド後に Manager を起動します。**Manager を起動するだけでは Discord へ適用されません。** 適用する対象を画面で選んでください。

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `payload/` と `dist-manager/` を生成 |
| `npm run manager` | ビルドして開発用 Manager を起動 |
| `npm run typecheck` | TypeScript の型検査 |
| `npm test` | Vitest のテストを実行 |
| `npm run dist:manager` | portable 配布用 exe を `dist/` に生成 |

配布ファイル名は `VoiceCordManager-<version>.exe` です。Frida のネイティブランタイムはペイロードと一緒に配布されます。

### 構成

| ディレクトリ | 役割 |
| --- | --- |
| `src/manager/` | Manager の画面、Discord の検出、ASAR の適用と解除 |
| `src/patcher/` | Discord の main プロセスへ組み込む処理 |
| `src/preload/` | Discord の画面と UI の橋渡し |
| `src/mainworld/` | Discord の画面内の情報採取 |
| `src/ui/` | React 製サウンドボードと音量調整画面 |
| `src/engine/` | 音声エンジン |
| `src/agent/` | Frida の音声フック |
| `src/shared/` | 設定、型、パスなどの共通処理 |
| `test/` | 自動テスト |

開発上の決定事項と検証範囲は [DEV-NOTES.md](docs/DEV-NOTES.md)、作業記録は [PROGRESS.md](docs/PROGRESS.md)、残件は [TASKS.md](docs/TASKS.md) にまとめています。
