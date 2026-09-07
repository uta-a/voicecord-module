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
- [ ] Tailwind の事前コンパイル（M1-e で有効化。今は空の CSS を流している）

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
- [ ] 既存 renderer（`App.tsx` + 6 コンポーネント + `components/ui/*`）をコピー
- [ ] Tailwind を `important: '#vc-root'` + preflight 無効でスコープ化
- [ ] `index.css` のグローバルセレクタ 6 箇所を `#vc-root` 配下へ
- [ ] Radix Portal 4 箇所を `#vc-root` 配下のコンテナへ
- [ ] `App.tsx` の `h-screen` → `h-full`
- [ ] エンジンは全部モック

### M1-f マネージャ exe
- [x] Electron アプリの骨格（`npm run manager` で起動）
- [x] インストール走査テーブルの表示（状態・連鎖・最終起動日時・要再適用の警告）
- [x] 適用 / 解除（VoiceCord のみ / 素に戻す）/ 再適用
- [x] Discord 起動中は適用を拒否（tasklist で判定。強制終了はしない）
- [x] 復旧手順の表示
- [x] 多重起動防止（同じ app.asar を同時に触らせない）
- [ ] electron-builder で exe に固める（M6）
- [ ] AV 除外の案内（M6）

### M1-g 実機検証（**適用前にユーザーへ確認**）
- [ ] Canary に適用 → Discord が正常起動
- [ ] FAB が出る / 既存 UI が崩れずに描画される
- [ ] Radix 系が全部操作できる
- [ ] テキスト入力中に Discord のショートカットが暴発しない
- [ ] **isolated world で `AudioContext` / `setSinkId` / `enumerateDevices` が動く**（判断 C の生死）
- [ ] ポップアウト窓に FAB が出ない
- [ ] Discord 側の回帰なし（メッセージ / VC / 画面共有 / 通知 / テーマ）
- [ ] Vencord 連鎖テスト（Canary の shim に Vencord を足す → 外す）
- [ ] 解除で素に戻る。適用→解除→適用を 3 往復
- [ ] 整合性チェックの確認（24 時間常用）

## M2 以降

計画ファイル参照。M2 = IPC 疎通（エンジンはフェイク）、M3 = 実エンジン、
M4 = ffmpeg 廃止、M5 = 堅牢化、M6 = マネージャ仕上げ、M7 = Stable 受け入れ。
