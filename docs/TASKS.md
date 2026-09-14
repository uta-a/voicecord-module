# タスク

計画: `~/.claude/plans/voicecord-v0-2-0-github-com-uta-a-disco-serialized-phoenix.md`

開発・テスト対象は **Discord Canary**。常用の Stable は M7 まで触らない。

決定事項、検証条件、再調査を省くための知見: [DEV-NOTES.md](DEV-NOTES.md)。
今後も調査結果は docs/ に根拠と未確認の範囲を残す。

## 次に取り組むタスク（2026-09-14）

上から順に進める。24 時間常用の観察は他の作業と並行できる。
実機操作は CDP + Playwright MCP を使用し、受信側の確認が必要な項目はユーザーと実施する。
検証済みの詳しい記録は下の各マイルストーン、再利用する知見は [DEV-NOTES.md](DEV-NOTES.md) を参照。

1. [ ] M3: 修正版の engine kill 後、実際の送信ゲートが 2 秒以内に閉じるか再確認する。
   kill 時刻と受信側の音・送信インジケーターの消失時刻を記録する。
   UI の再生行消失はゲート閉鎖の証拠にしない。基準を超えた場合は原因調査と修正を行う。
2. [ ] M4: 新デコード経路で音源別音量を見直す。
   左右平均を維持する確定方針で推奨音量・ピーク制約・変更対象を確認し、対象を確定して適用する。
   移行済みの個別調整を無条件に上書きしない。
3. [ ] M4: 声を再測定し、音源とのバランスを校正する。
   音源側の基準を確定してから 3 秒の発話測定を行い、希望する声との差を適用する。
   受信側でステレオ・モノラルの代表音源と声のバランス、音割れを確認し、変更前後の値を記録する。
4. [ ] M1: Discord の残りの回帰確認を終える。
   受信側で画面共有の映像、ユーザー操作でメッセージ送信、OS 通知バナー・通知音を確認する。
   テーマ切替・VC・ポップアウトの既存確認と合わせて結果を残す。
5. [ ] M1 / M4.5: FAB が純正ポップアウトボタンを遮る問題を解消する。
   純正 UI への移行後も、フォールバック FAB が通常クリックを妨げないことを確認する。
6. [ ] M1: Canary を 24 時間常用し、起動・VC・整合性チェックに問題がないことを確認する。
   観察開始・終了時刻と、その間の Discord 更新・再起動の有無を記録する。
7. [ ] M4.5: Discord 純正意匠のボタンとポップアウトへ作り替える。
   2026-09-14 のユーザー決定: ページ側スクリプトの合成クリックへの対策は「再生・送信だけ
   `event.isTrusted` を検査する」。全停止・個別停止・開閉は合成でも効かせる。
   M4 完了後、下の M4.5-a〜g を順に実施する。Vencord 共存、テーマ追従、再挿入の暴走防止、
   アンカー不在時と FAB フォールバック時の操作を Canary で検証する。
8. [ ] M5: ゲート復帰の 4 層とグローバル緊急停止ホットキーを仕上げる。
   2026-09-14 実装済み（実機未検証）: hook.js の `rpc.exports.dispose` でスクリプトが外される
   直前にゲートを閉じる（frida 16.7.19 で host の強制終了時にも dispose が走ることを実測）。
   OS グローバルの緊急停止 `Ctrl+Alt+Shift+X`（再生停止 + 遅延なしのゲート閉鎖、
   登録失敗は degraded でパネルに表示）。
   同日 Canary 1.0.1169 で確認: 起動後の degraded は 0 件（ホットキー登録成功）。OS から
   Ctrl+Alt+Shift+X を送ると、engine まで届いて「緊急停止しました」のログが UI 側に返る。
   VC 中の再生停止・受信側でのゲート閉鎖は未確認。
   engine 終了処理、hook の復帰処理、Discord の before-quit、緊急停止の各経路を確認する。
   engine 強制終了・Discord 終了・再アタッチ・緊急停止で実際の送信が止まることを検証する。
   旧計画の「最長 5 秒程度」は 2 秒以内の達成証拠として扱わない。
9. [ ] M6: マネージャを exe 化し、配布・復旧・ドキュメントを仕上げる。
   2026-09-14 のユーザー決定: exe は portable（インストール不要）。旧リポジトリは README に
   凍結と後継の注記だけ入れ（済: 旧リポジトリ `6e51ba1`）、解析ドキュメントは触らない。
   AV 除外の案内は適用完了メッセージに追加済み（`7dfb1f4`）。
   electron-builder、AV 除外の案内、適用・解除・更新後の再適用・復旧手順を確認する。
   注入先・実測レート・frida の ABI に関する旧記述を訂正する。
   旧リポジトリは参照専用のため、旧 README の訂正は変更範囲を確認してから行う。
10. [ ] M7: Canary の受け入れ完了後、Stable の受け入れを行う。
    Stable に触れる前に適用範囲を確認する。読み取りプローブで発火関数・バッファ・レートを実測し、
    実際に使われる float / int16 経路、校正、受信音声、Vencord 共存、M5 の停止・復帰を検証する。
    48000 Hz / 480 サンプルを決め打ちしない。

各タスクの完了時はチェックと根拠を更新し、未確認事項を残す。
旧 ffmpeg 既定 downmix との差は採用しない互換条件として記録済み。再び補正実装の残タスクにはしない。

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
- [x] ポップアウト窓に FAB が出ない（2026-09-14、Canary の実際の `/popout` 窓で
      CDP + Playwright MCP により `#vc-root` / VoiceCord ボタンが両方 0 件と確認）
- [ ] Discord 側の回帰なし（メッセージ / VC / 画面共有 / 通知 / テーマ）→ 要・手動
- [ ] 整合性チェックの確認（24 時間常用）→ 要・経過観察

2026-09-14 の回帰確認（Canary、CDP + Playwright MCP）:
- テキストチャンネルの既存メッセージと入力欄、音声設定画面の表示を確認。
  メッセージ送信は未実施。
- テーマをダーク→ライトへ切り替え、FAB が表示されることを確認。元のダークへ復元済み。
- 検証用 Chrome の `about:blank` 窓で画面共有を開始・停止でき、engine の
  アタッチが維持されることを確認。受信側の映像確認は未実施。
- **回帰確認で問題を発見**: VC 全画面の「ポップアウト」ボタン中央へのクリックを
  `.vc-fab` が遮る（Playwright の pointer interception で再現）。FAB はドラッグ可能だが、
  既定位置が Discord の操作を隠すため、回帰なしのチェックは未完了のままとする。
- 同じポップアウトボタンをキーボードで操作し、実際の VC ポップアウトを開いた。
  VC 参加者・通話操作が表示され、`#vc-root` / FAB が両方 0 件であることを追加確認。
  「Discordに戻る」でポップアウトを閉じ、メイン窓への復帰とアタッチ維持を確認。
- 別アカウントから Canary 宛てにテスト DM を送ってもらい、サイドバーの
  「1 件の未読のメッセージ」と、DM 本文の受信・表示を確認。
  DM 画面へ移動しても engine のアタッチと 32000 Hz 表示を維持。
  DM 窓を前面にした後、未読バッジが消灯することも確認。
  OS の通知バナー・通知音は CDP では確認できていない。

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
- [ ] engine を kill → 開いていたゲートが 2 秒以内に閉じる → 受信側で目視約 2 秒。
      厳密な時間判定は未確認
- [x] VC 退出 → 再入場で噛み直す（2026-09-14、再入場後に再生復帰。
      受信側で聞こえることを確認し、engine kill・復帰後の再生も正常と報告）

2026-09-14 の追加確認（Canary 1.0.1169、CDP + Playwright MCP）:
- 初回入場で自動アタッチし、32000 Hz / 320 サンプルを表示。
- Discord の切断操作後に同じ VC へ再入場。renderer PID 43660 / engine PID 42420
  へのアタッチを維持し、パネルが「VC接続済」へ復帰。
- 再入場後に chime を再生し「VCへ送信中」を確認。全停止で再生中が 0 件へ戻った。
- 受信側での音声・ピッチ・速度、Connection* の更新は未確認。
  後続の受信確認では chime が聞こえ、engine kill・復帰後の再生も正常と報告された。

同日の engine kill 確認（受信側が一般 VC に参加し、chime が聞こえると確認後）:
- 08:47:12.456 UTC に engine PID 42420 を強制終了。renderer PID 43660 は生存し、
  新しい engine PID 43976 で自動再アタッチ、32000 Hz / 320 サンプルを再表示。
- DOM 監視では「マイク送信中」が消えたのは 08:47:18.116 UTC（約 5.7 秒後）。
  これは UI の変化であり、実際のゲート閉鎖時刻の証拠ではない。2 秒要件は未確認。
- 自動復帰後も「再生中 1 / chime / VCへ送信中」が残っていた。
- 受信側は「2s 程残った後に消えた」と報告。目視では要件の境界付近であり、
  厳密な 2 秒以内の達成は未確定。表示に残った再生項目は全停止で 0 件へ戻した。

同日の表示残留修正後の確認:
- engine の異常終了を `engineLost` で UI へ通知し、再生行・試聴・計測を掃除。
  開いていたマイク表示は閉鎖と断定せず `unknown` へ移す。
- 手動再起動後の旧 engine の遅延 message / exit は、現在の child と同一かを確認して無視。
- 全 401 テスト / 型チェック / ビルドが成功。遅延通知ガード追加後は関連 23 テスト、
  型チェック、ビルドを再実行して成功。差分レビューの指摘も解消。
- 修正版を Canary に反映し、09:13:33.047 UTC に engine PID 49688 を強制終了。
  09:13:33.087 UTC（約 40 ms 後）に再生行が 0 件、マイク表示が不明へ変化。
- 09:13:37.554 UTC（約 4.5 秒後）に renderer PID 50272 / engine PID 48936 へ
  自動再アタッチし、32000 Hz / 320 サンプルを表示。再生行は 0 件のまま。
- 復帰後の chime 再生で新しい再生行と「マイク送信中」が出ることを確認。
  受信側は復帰後の chime を「正常に聞こえる」と報告。
  修正版 kill 後の厳密なゲート閉鎖時刻の確認は引き続き必要。

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

### M4 の実機確認（2026-09-14、Canary 1.0.1169）

- [ ] 旧 ffmpeg / 新 decodeAudioData の RMS 差が 0.5 dB 以内。
  旧経路の `-ac 1 -ar 48000 -f f32le` と、実際の isolated preload API の
  `getPcm` / `sourceStats` を比較。同じ `measureSamples` の二段ゲート RMS で算出。
  差は `20 * log10(new / old)`、音量補正・注入なしでデコード結果を比較。
  - chime.wav（48k stereo）: -2.988 dB。全サンプル RMS 差は -3.010 dB。
  - roblox-death-sound_1.mp3（44.1k stereo）: -3.010 dB。
  - bye-bye-soundbible.mp3（44.1k stereo）: -3.010 dB。
  - voice-message.ogg（48k mono Opus）: +0.009 dB（基準内）。
  ステレオは旧 ffmpeg の downmix と新経路の左右平均の係数が異なる。
  2026-09-14 のユーザー判断で新しい左右平均を維持し、音源別音量・校正を見直す方針に確定。
  旧既定経路への音量互換性は採用しない。上の無補正比較の未達は測定結果として残す。
- [x] 新経路と同じ左右平均の参照 PCM で RMS 差が 0.5 dB 以内。
  ステレオの ffmpeg 参照に `pan=mono|c0=0.5*c0+0.5*c1` を指定して再測定。
  chime -0.000038 dB / roblox +0.000219 dB / bye-bye -0.000051 dB /
  mono Opus +0.008708 dB。検証条件と次回の手順は DEV-NOTES.md。
- [ ] 新経路で音源別音量を見直し、声を再測定・校正して受信側でバランスを確認。
  音源側の基準確定→既存の個別音量の適用対象確認→声の測定→設定適用の順。
  一律の 3 dB 増幅、旧設定の自動削除・リセットは行わない。
- [x] .wma の失敗がユーザーに表示される。
  ffmpeg で作った 1 秒の実 WMAv2 ファイルを設定済み音源フォルダに置き、
  再読込→タイル再生で「この形式は再生できません…Unable to decode audio data」の
  トーストを確認。タイルは一覧に残り、再生中は 0 件、engine アタッチは維持。
  検証用ファイル・スクリプトは削除し、再読込で検証用タイルが消えることも確認。

計画ファイル参照。M4 = 旧経路との突き合わせと `.wma` のエラー表面化、
M4.5 = Discord ネイティブ意匠への UI 作り替え、M5 = 堅牢化、
M6 = マネージャ仕上げ、M7 = Stable 受け入れ。

## M4.5 — Discord ネイティブ意匠への UI 作り替え

着手は **M4（ffmpeg 廃止）の完了後**。M1-e で移植した shadcn パネルは捨て、
純正サウンドボードと見分けのつかないボタン + ポップアウトに作り替える。
計画ファイルの「M4.5」節が正。

### M4.5-a 実測（Canary を `--remote-debugging-port` 付きで起動して CDP から採る）

2026-09-14、Canary 1.0.1169（Vencord 不在、ダークテーマ、DM 通話中）で CDP から読み取り:
- 純正のサウンドボードボタンは**チャット欄ではなく音声パネル**にある。
  `container_e131a9 > actionButtons_e131a9` の 4 番目（カメラ / 画面共有 /
  アクティビティ / サウンドボード）。各 78x32、r 8px、lottie アイコン 18px。
  `aria-label="サウンドボードを開く"` はこのボタンだけ。他の 3 つは
  `hiddenVisually` の span で名前を持つ。開いている間は `aria-expanded="true"` と
  `greyButtonActive_e131a9` が付く
- `expression-picker-chat-input-button` は 3 個あるがチャット欄側のもので、
  サウンドボードボタンには付いていない（計画の 2 段目の前提は外れた）
- 純正ポップアウト `picker__09f65`（role=dialog）: 531x520、r 8px、
  shadow = `--shadow-border` + `--shadow-high`。上にヘッダ 64px（検索 40px 高、
  placeholder「完璧な音を見つけよう」、右に音量の歯車）、左にカテゴリ列 48px、
  セクション見出し 32px（14px / 600）、タイルは 148x40 / r 8px / gap 8px、
  行は padding 0 0 8px 8px。タイルは絵文字 + 名前、ホバーでプレビューと
  お気に入りのボタンが重なる。詳細な骨格は DEV-NOTES.md
- テーマ変数は新体系。`--background-primary` / `--background-secondary` /
  `--text-normal` / `--interactive-normal` は**空**。実在するのは
  `--background-base-low/lower/lowest`、`--background-surface-high/higher/highest`、
  `--text-default/muted/strong`、`--border-subtle/normal/strong`、
  `--interactive-*`、`--control-*`、`--icon-*`、`--radius-xs〜xxl`、
  `--shadow-high`、`--shadow-border`
- `window.webpackChunkdiscord_app` は存在、`window.Vencord` は不在

- [ ] preload の `webFrame.executeJavaScript` が実 CSP 下で通るか
      ※ ワールドは Electron v42.11.2 のソースで確定済み（`kMainWorldId` を明示的に渡す）。
        CSP をすり抜ける点は公式の明文が無いが、Vencord が Stable で現に動いているのが実証。
      → 否なら `webContents.debugger` の `Page.addScriptToEvaluateOnNewDocument`、
        それも駄目なら採取役ごと削り、発見連鎖の 2 段目以降で運用する
- [ ] `webpackChunkdiscord_app.push` で `__webpack_require__` を受け取れるか
- [x] サウンドボードボタンの DOM 位置・`aria-label` の実文言・親コンテナ
- [x] `expression-picker-chat-input-button` が実際に付いているか（付いていない）
- [x] 純正ポップアウトの寸法・余白・角丸・影・タイルのサイズと段組み
- [ ] Discord のテーマ変数の実名（新体系と確認）とライト/ダークの値（ダークのみ採取）

### M4.5 実機確認（2026-09-14、Canary 1.0.1169、ダーク、サーバーの VC）
- [x] VC 参加中、純正サウンドボードボタンの隣に接ぎ木される。FAB は非表示
- [x] **実機で直した**: 純正ボタンはツールチップ用の無名 div に単独で包まれており、
      包みの中に差し込んで縦に積まれていた（`f727514`）。修正後は 5 ボタンが 60x32 で横一列
- [x] ポップアウトが開く。幅 531 / 角丸 8px / 影は純正と一致
- [x] **実機で直した**: 塗りが純正より 1 段明るかった（PopoverContent 既定の bg-popover が
      勝っていた、`fdfae60`）。修正後 rgb(36,36,41) で純正と一致
- 高さは 576（純正 520）。下端の全体音量・全停止の帯のぶん。決定 6（縦に伸ばして全部入れる）どおり
- Discord の窓が非表示（`document.hidden`）の間は開くアニメーションが止まり、
  0.95 倍のまま計測される。窓が見えていれば 531 になる。計測時の注意として残す
- [ ] ライト / ミッドナイトへの追従、DM / チャンネル移動での出し入れ、1 分の再挿入回数
- [ ] VC 全画面の「ポップアウト」ボタンを塞がないこと

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
