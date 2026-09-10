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

### M2-e 実機確認（Canary）— 未実施
- [ ] UI の状態機械がスタブのイベントで端から端まで駆動する
- [ ] 旧 config から `sourceVolumes` と `calibration` が引き継がれ、旧ファイルは残る
- [ ] スタブエンジンを外から kill → FAB が赤 → 3 秒で再起動して戻る
- [ ] `chooseFolder` のダイアログが Discord の窓を親にして開く

## M3 以降

計画ファイル参照。M3 = 実エンジン（frida）、M4 = 旧経路との突き合わせと
`.wma` のエラー表面化、M4.5 = Discord ネイティブ意匠への UI 作り替え、
M5 = 堅牢化、M6 = マネージャ仕上げ、M7 = Stable 受け入れ。

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
