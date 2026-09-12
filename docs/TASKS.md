# タスク

計画: `~/.claude/plans/voicecord-v0-2-0-github-com-uta-a-disco-serialized-phoenix.md`

開発・テスト対象は **Discord Canary**。常用の Stable は M7 まで触らない。

## M0 — Canary の基準線を取り直す（**ユーザー作業**）

既存の `VoiceCord.exe` で実施する。新 mod では絶対にやらない。

- [ ] 既存 exe を Canary に attach → VC 参加 → 2 人目で受聴
- [ ] calibration を回して `vRms` / `vPeak` / `activeRatio` を記録（M3 以降の突き合わせ基準）
- [ ] `gate open` → `gate close` が対で出ることを確認
- [ ] VC 再入場で `Connection*` が更新されることを確認

完了判定: 2 人目に明瞭に届く / 自分の声が劣化しない / 黙っても途切れない / 退出後に送信が残らない

## M1 — shim と UI の骨格（frida 一切なし）

### M1-a 基盤
- [x] リポジトリ初期化、TypeScript + vitest
- [x] shim 生成（`shimSource.ts`）
- [x] 最小 asar ライタ（`asarBuild.ts`）
- [x] `app.asar` の形態判定（`asarInspect.ts`）
- [x] 適用・解除（`apply.ts`）
- [x] インストール走査とパッチ状態（`scan.ts`）
- [x] 復旧手順（`docs/RESTORE.md`）
- [x] ランタイムのパス定義（`paths.ts`）
- [x] `state.json` の読み書き（`state.ts` / `stateStore.ts`）

### M1-b ビルド
- [x] esbuild で patcher / preload を吐く `build.mjs`（`npm run build` → `payload/`）
- [x] `eval` / `new Function` が混入していないかのビルド時検査
- [x] Tailwind の事前コンパイル（`buildCss.mjs` → `.tmp/ui.css`。preload が文字列で取り込む）

### M1-c patcher（Discord main プロセス）
- [x] サブシステムを独立させた起動（`subsystems.ts`。個別に落ちても他は動く）
- [x] `session.registerPreloadScript` で preload を登録（`preloadReg.ts`。BrowserWindow はラップしない）
- [x] `ipcMain` の骨格（`ipc.ts`。`voicecord:` 名前空間、二重登録ガード、未実装は理由つきで断る）
- [x] shim の位置から Discord インストールを割り出す（`locate.ts`）
- [x] 起動のたびに `state.json` を自己更新（可視化 4）
- [ ] devtools フラグ → マネージャから Discord の settings.json に
      DANGEROUS_ENABLE_DEVTOOLS_... を書く形にする（オプトイン、M1-f）

### M1-d preload（isolated world）
- [x] splash / iframe / ポップアウトのガード（`guard.ts`。ホスト名の完全一致も）
- [x] `window.api` ブリッジ（`api.ts`。contextBridge 不要、ペイロードの形も検証）
- [x] `#vc-root` の生成とスタイル注入（`styles.ts`。adoptedStyleSheets ＋ フォールバック）
- [x] FAB（エンジン状態から独立して無条件に出す ＝ 可視化 1、色は可視化 2）
- [x] パネル枠（ドラッグ移動・リサイズ・Esc で閉じる）
- [x] キーボードの封じ込め（`keyboard.ts`。document の capture に
      stopImmediatePropagation。ホットキーは code で判定）

### M1-e UI 移植
- [x] 既存 renderer（`App.tsx` + 6 コンポーネント + `components/ui/*`）をコピー
- [x] Tailwind を `important: '#vc-root'` + preflight 無効でスコープ化（`prefix` は付けない）
- [x] `index.css` のグローバルセレクタを `#vc-root` 配下へ。preflight の代替リセットを手書き
- [x] base 層の universal defaults も postcss で `#vc-root` 配下へ（`important` の対象外なので）
- [x] Radix Portal を `#vc-root .vc-portal` へ固定
- [x] `App.tsx` の `h-screen` → `h-full`
- [x] エンジンは `mockApi.ts` でモック（`store.ts` の窓口 1 行で実体に差し替えられる）

### M1-f マネージャ exe
- [x] Electron アプリの骨格（`npm run manager` で起動）
- [x] インストール走査テーブルの表示（状態・連鎖・最終起動日時・要再適用の警告）
- [x] 適用 / 解除（VoiceCord のみ / 素に戻す）/ 再適用
- [x] Discord 起動中は適用を拒否（tasklist で判定。強制終了はしない）
- [x] 復旧手順の表示
- [x] 多重起動防止（同じ app.asar を同時に触らせない）
- [ ] electron-builder で exe に固める（M6）
- [ ] AV 除外の案内（M6）

### M1-g 実機検証

CDP（`--remote-debugging-port`）で機械的に確認した。Canary 1.0.1158。

- [x] Canary に適用 → Discord が正常起動（**Vencord 不在なので shim 末尾の
      冪等ブートが唯一の経路。ここが機能することの実証**）
- [x] FAB が出る（`#vc-root` / `.vc-fab` / `.vc-panel` を DOM で確認）
- [x] スタイルが効いている（`position:fixed` / `pointer-events:none`）。
      **CSP は一切書き換えていない**
- [x] ホットキー Ctrl+Shift+B で開閉、Esc で閉じる
- [x] キー封じ込め（パネル内は止まり、パネル外は素通し）
- [x] **isolated world の自己診断が全項目 ok**（判断 C は成立）
      `AudioContext=ok(48000Hz) / setSinkId=ok / enumerateDevices=ok /
      labeled=10 / adoptedStyleSheets=ok`
- [x] `window.api` がメインワールドから見えない（`typeof window.api === "undefined"`）
- [x] patcher が Discord の中で動いた証跡（`state.json` の `lastPatcherRunAt`）
- [x] Vencord 連鎖テスト（Canary の shim に Vencord を足すと、FAB と Vencord と
      Discord 本体が同時に動く。確認後 VoiceCord 単独に戻した）
- [x] 解除で素に戻る。適用→解除→適用を 3 往復してバイト単位で一致（SHA-256）
- [x] 既存 UI が崩れずに描画される（要素 359 個 / タイル 33 個 / Tailwind 有効）
- [x] Radix のダイアログが `#vc-root .vc-portal` に出る（body へ漏れていない）
- [x] Discord 側へスタイルが漏れていない（`body` は `content-box` のまま、
      `:root` の `--background` も未定義）
- [ ] ポップアウト窓に FAB が出ない（要・実際のポップアウト操作）
- [ ] Discord 側の回帰なし（メッセージ / VC / 画面共有 / 通知 / テーマ）→ 要・手動
- [ ] 整合性チェックの確認（24 時間常用）→ 要・経過観察

## M2 — IPC 疎通（エンジンはスタブ）

### M2-a config
- [x] 読み書きと sanitize（`shared/config.ts`）。BOM / .broken 退避 / tmp→rename
- [x] 旧 `%APPDATA%\voicecord\config.json` からの一度きり・非破壊な移行
- [x] 既定の音源フォルダ `%USERPROFILE%\Documents\VoiceCord\sounds` を自動作成

### M2-b エンジンの監督
- [x] `utilityProcess.fork` の子として起こす（`patcher/engineHost.ts`）
- [x] 落ちたら 3s→5s→10s→30s のバックオフで再起動。10 秒生き延びたら先頭へ戻す
- [x] 死んだときに待っている要求を必ず落とす（UI の Promise を吊らせない）
- [x] stdout / stderr を `{ev:'log'}` として UI へ（別窓を開かずに読める）
- [x] スタブエンジン（`src/engine/stub.mjs` → `payload/engine.mjs`）
- [x] IPC のイベント型に `engine` 変種。`EngineEvent` → `VoiceCordEvent` へ改名

### M2-c IPC の配線
- [x] 15 チャンネルを実体へ。設定とファイルは patcher、再生系は engine へ転送
- [x] `scanFolder`（`patcher/soundsFs.ts`。id 採番の規則は移植元のまま）
- [x] `readSoundFile` のパス検証（realpath / フォルダ配下 / 音声拡張子のみ）
- [x] `chooseFolder` は Discord の窓を親にして開く
- [x] `reattach` は転送ではなくエンジンの起こし直し

### M2-d renderer の窓口
- [x] `store.ts` の `engineApi` を `window.api` に差し替え（不在ならモック）
- [x] デコード経路（`preload/decode.ts`）。**M4 のデコード実装をここへ前倒し**
- [x] `play` は PCM を engine へ渡してから鳴らす

### M2-e 実機確認（Canary 1.0.1165）

CDP（`--remote-debugging-port=9223`）で機械的に確認した。

- [x] UI の状態機械がスタブのイベントで駆動する（タイル 32 件 / 「VC接続済」／
      `効果音と声の差 -6.5 dB`。スタブの `vc active` が store まで届いている）
- [x] 旧 config から `sourceVolumes` 32 件と `calibration` が引き継がれ、
      **旧ファイルは残っている**
- [x] エンジンだけを kill → `failed`（理由つき）→ バックオフ後に再起動 →
      `searching` → `attached`。実測: `+1.8s failed …5 秒後に再起動します` →
      `+6.8s searching` → `+8.3s attached`
- [x] `chooseFolder` のダイアログが Discord の窓を親にして開く。
      実測: ダイアログ（class `#32770`）の `owner` が Discord のメインウィンドウ、
      かつ Discord 側が `enabled=False`（＝モーダル）。キャンセルで `null` が返る
- [x] ページ再読み込みでエンジンを殺さない（`enginePid` が前後で同一）

実機で 2 点直した（`439cd99`）
- `attach` が毎回エンジンを再起動していた（M3 では frida ごと落ちる）
- どのプロセスがエンジンか実機で判別できなかった → `enginePid` を状態に追加

## M3 — 実エンジン（frida 投入）

### M3-a frida の導入
- [x] `frida@16.7.19` を依存に追加（N-API v8 なので再ビルド不要）
- [x] ランタイムを `payload/node_modules` へ配る（`build.mjs`）。
      バンドルに巻き込まない（`bindings` が package.json と build/ を上へ辿るため）。
      同じ内容ならコピーしない（75MB あるので毎回コピーすると遅い）
- [x] `enumerateProcesses({scope:'metadata'})` が **Windows で ppid を返す**ことを実測
      （計画の未決事項の 1 つ。`path` / `user` / `started` も取れる）

### M3-b 移植
- [x] `transmit.ts`（送信ゲート）— 論理を一切変えずに移植
- [x] `injector.ts` — frida を**遅延ロード**にした（起動失敗の理由を上へ返すため）
- [x] `core.ts` — ffmpeg 由来のものを全部落とし、PCM は renderer から受け取る
- [x] `engine.ts` — parentPort の電文、状態通知、後始末
- [x] `hook.js` を無改造で移植（SHA-256 一致）

### M3-c supervisor（`pidfind.ts` の書き換え）
- [x] 自分自身を除く／親が自分の親であるものだけに絞る
- [x] 不合格 PID のキャッシュ。検査失敗は諦めない
- [x] 3s→5s→10s→30s のバックオフ。子プロセスの集合が変わったら先頭へ戻す
- [x] 噛んだ後は 30 秒ごとの見張り。`detached` で即座に探し直す

### M3-d テスト
- [x] `hook.test.ts` を移植（import 2 行の修正だけで 16 件通過）
- [x] `transmit.test.ts` 17 件 / `supervisor.test.ts` 14 件 / `engineCore.test.ts` 18 件

### M3-e 実機検証（Canary 1.0.1169）
- [x] **frida が Electron 42 の utilityProcess 内で読み込める**（ABI の主張が実機で成立）
- [x] エンジンが `searching` で待機する（VC 未参加なのでこれが正常）
- [x] `frida_binding.node` を退避 → Discord は正常起動し、パネルに
      **試したパスまで含めた理由**が出る。エンジンは終了せず生き残る
- [x] 戻して再アタッチ → 新しい PID で復帰する
- [x] VC に入る → **何も操作せず** FAB が緑になり注入先の PID が出る
- [x] **タイルを叩くと 2 人目に正常なピッチ・速度で聞こえる**（実機確認）
- [x] 注入レートが実測され、その値でデコードされていることを数値で確認。
      5 秒の ogg が 48000 なら 240000 サンプルのところ **160000 = 32000Hz** で
      hook に渡っている。ゲートの open/close も対で出る
- [x] engine を kill → 自動で再起動 → 同じ注入先へ噛み直す（何度も確認）
- [ ] engine を kill → 開いていたゲートが 2 秒以内に閉じる → 要・2 人目
- [ ] VC 退出 → 再入場で噛み直す

### 実機で 3 回直した

1. **不合格が恒久だった**（`7051a08`）。注入先が VC 参加時に新しく生まれる
   プロセスである前提だったが、実際は長命な renderer が krisp を後から載せる。
   起動直後に一度落とすと永久に噛まない
2. **レートを一度きりしか測っていなかった**（`544a138`）。krisp がロードされた
   瞬間に検査すると 0 回で返り、レートが永久に不明のまま 48000 で鳴らしていた
3. **接続中のレート変更に追随できなかった**（`0fe3a17`）。30 秒ごとに見張る

### 切り分けに時間をかけた原因（記録として残す）

「Canary だと遅い / Stable は正常」という報告の実体は、**ユーザーが旧
`VoiceCord` プロジェクトを `npm run dev` で起動していた**ことだった。旧アプリは
48kHz 決め打ちなので、Canary（消費 32000）では遅く、Stable（消費 48000）では
正常に鳴る。新構成には**起動するアプリが無い**（Discord の中に入っている）という
最も基本的な差分を共有できておらず、こちらの mod は一度も鳴らされていなかった。

同じ取り違えを防ぐため、M6 で旧リポジトリの README に「exe / dev 版は凍結。
後継は VoiceCord-module で、起動するアプリは無い」と明記する。

### 途中で起きたこと
- Canary がセッション中に 1.0.1165 → **1.0.1169 へ自動更新**され、パッチが外れた。
  マネージャの走査が `要再適用（1.0.1165 に適用済みだった）` を正しく出した（可視化 3 の実証）

### 実機で判明した、旧解析との食い違い（Canary 1.0.1169）

**注入先が audio utility ではなく renderer になっている。**

- 本物の `audio.mojom.AudioService`（`--service-sandbox-type=audio`）は
  **frida のエージェント注入を拒否する**（3 回試して 3 回とも。一過性ではない）。
  素の node プロセスから試しても同じなので、我々が Discord の子である
  ことが原因ではなく、対象のサンドボックスが原因
- renderer には入れる。**Discord がメインウィンドウに `sandbox:false` を
  設定しているから**（preload 注入の根拠と同じ事実）
- その renderer に必要なものが全部揃っている
  - `discord_krisp.node` … `KrispNCProcessFloat` / `KrispNCProcess` の両方
  - `discord_voice.node` … `?GetStats@Connection@voice@discord@@…` と
    `?SetPTTActive@Connection@voice@discord@@QEAAX_N00@Z`
- 旧ドキュメント（`ANALYSIS.md:53` / `CLAUDE.md:51` / `re/RE-NOTES.md:80`）は
  「utility audio」と書いており、今日の観測と食い違う。M6 で訂正する

**フレームが 480 / 48kHz ではなく 320 / 32kHz になっている。**

```
KrispNCProcessFloat(session, in, cnt, out, outCap)   ← 引数レイアウトは旧解析どおり
  cnt = 320, outCap = 320, 発火は 100Hz（5s で 500 回 / 20s で 2001 回）
  → 320 × 100Hz = 32000 Hz
  in の最大振幅 0.0229（無発話時の環境ノイズ）/ out の最大振幅 0.0008
  → Krisp が実際に抑圧している = 生きた収録経路
```

`re/RE-NOTES.md:75` は `(session, float* in, int n=480, float* out, int m=480)`、
10ms/480 サンプル・48kHz mono と書いている。**レートが変わった。**

影響: `hook.js` は `cnt` に依存しない作りなので落ちないが、我々が渡す PCM は
48kHz なので **2/3 の速度・低いピッチで鳴る**。レートを実行時に検出して
デコード側を合わせる必要がある（`hook.js` は無改造のまま、`probePid` と同じ
短命スクリプトで `cnt` と発火レートを測るのが筋）。

## M4 以降

計画ファイル参照。M4 = 旧経路との突き合わせと `.wma` のエラー表面化、
M4.5 = Discord ネイティブ意匠への UI 作り替え、M5 = 堅牢化、
M6 = マネージャ仕上げ、M7 = Stable 受け入れ。

## M4.5 — Discord ネイティブ意匠への UI 作り替え

着手は **M4（ffmpeg 廃止）の完了後**。M1-e で移植した shadcn パネルは捨て、
純正サウンドボードと見分けのつかないボタン + ポップアウトに作り替える。
計画ファイルの「M4.5」節が正。

### M4.5-a 実測（Canary を `--remote-debugging-port` 付きで起動して CDP から採る）
- [ ] preload の `webFrame.executeJavaScript` が実 CSP 下で通るか
      ※ ワールドは Electron v42.11.2 のソースで確定済み（`kMainWorldId` を明示的に渡す）。
        CSP をすり抜ける点は公式の明文が無いが、Vencord が Stable で現に動いているのが実証。
      → 否なら `webContents.debugger` の `Page.addScriptToEvaluateOnNewDocument`、
        それも駄目なら採取役ごと削り、発見連鎖の 2 段目以降で運用する
- [ ] `webpackChunkdiscord_app.push` で `__webpack_require__` を受け取れるか
- [ ] サウンドボードボタンの DOM 位置・`aria-label` の実文言・親コンテナ
- [ ] `expression-picker-chat-input-button` が実際に付いているか
- [ ] 純正ポップアウトの寸法・余白・角丸・影・タイルのサイズと段組み
- [ ] Discord のテーマ変数の実名（`--background-primary` 系か新しい系か）とライト/ダークの値

### M4.5-b メインワールドの採取役（`src/mainworld/harvest.ts`）
- [ ] 読み取り専用。`window.api` も IPC も渡さない
- [ ] **preload の `webFrame.executeJavaScript` で投入**（Vencord と同じ経路）。
      別バンドル `payload/harvest.js` にして preload が文字列で読む
- [ ] **`Function.prototype` には絶対に触らない。** Vencord は `"m"` を
      `configurable:false` で定義しているので、同じ手を使うと後発が TypeError で落ちる
- [ ] `window.Vencord?.Webpack` が居れば借りる。居なければ
      `webpackChunkdiscord_app.push` で `__webpack_require__` を取る
- [ ] 採取役の中で `eval` / `new Function` を使わない（メインワールドなので CSP の
      `unsafe-eval` 制限を通常どおり受ける）
- [ ] 受け渡しは `window.postMessage` か CustomEvent（素の文字列のみ）

### M4.5-c アンカー発見の 5 段フォールバック（`src/preload/anchor.ts`）
- [ ] 1 採取役の CSS モジュールのクラス名 / 2 リテラルの
      `expression-picker-chat-input-button` / 3 `aria-label` / 4 SVG の `d` か位置 / 5 FAB
- [ ] 何段目で見つかったかを状態に持つ
- [ ] 2 段目以下に落ちたら「次の更新で壊れうる」を 1 回警告
- [ ] 見つからないときに throw しない（Vencord の作法）。ただし握りつぶさず段位を出す

### M4.5-d 接ぎ木と再挿入（`src/preload/graft.ts`）
- [ ] アンカーの `className` をコピー。アイコンだけ差し替え
- [ ] `MutationObserver` で消えたら再挿入
- [ ] **自己トリガのループを断つ + 再挿入頻度に上限**（抜くと Discord ごと固まる）

### M4.5-e ポップアウト（`src/ui` 全面改装）
- [ ] Radix Popover を接ぎ木ボタンにアンカー、描画先は `#vc-root .vc-portal`
- [ ] メイン（グリッド + 全体音量）／歯車から設定（送信・モニター・入場サウンド）
- [ ] キャリブレーションと入場サウンドは Discord のモーダル意匠で中央ダイアログ

### M4.5-f テーマ追従
- [ ] `tailwind.config.js` の `colors` を `hsl(var(--x))` → `var(--vc-x)`
- [ ] `index.css` の HSL 三つ組を Discord 変数参照へ。**全てにフォールバック値**
- [ ] `SHELL_CSS` の直書き色も変数へ。`color-scheme: dark` の固定を外す
- [ ] `#vc-root` スコープ装置と `test/uiCss.test.ts` は維持

### M4.5-g 後始末
- [ ] `SoundItem` に `kind: 'file'` を足す（将来の Discord 音源注入の余地）
- [ ] `shell.ts` のパネル枠とホットキー開閉を削除。FAB は故障時フォールバックとして残す
- [ ] 音源フォルダの既定パスを自動作成（VC 外では UI が出ないため）
