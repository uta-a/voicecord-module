# 開発・検証メモ

最終更新: 2026-09-14

次回の作業はこのファイルで決定事項と検証条件を確認し、[TASKS.md](TASKS.md) で残件を確認する。
新しい調査結果は根拠となるソース、検証日、対象バージョン、未確認の範囲と一緒に docs/ に残す。
この文書は調査の再利用用。古い結果を現在の実機状態の証拠として使わない。

## 作業の前提

- 開発・検証は Discord Canary。Stable の変更と操作は M7 まで行わない。
- 旧リポジトリ `../VoiceCord` は参照専用。旧 exe と npm run dev を新 mod の検証に使わない。
- 注入先は Krisp 処理後の renderer。audio utility への注入を前提に戻さない。
- 注入レートは実測値。Canary 1.0.1169 では 32000 Hz / 320 サンプルを確認済み。
- 試聴と音源の RMS 計測は 48000 Hz。注入用 PCM は実測レートで作る。
- 旧 ANALYSIS.md、CLAUDE.md、re/RE-NOTES.md の注入先と固定レートの説明は古い。訂正は M6。

## M4 の音量方針

2026-09-14 にユーザーが選択した方針:

- 新経路の左右平均を維持する。ステレオのモノラル化は左右に 0.5 ずつを掛ける。
- 旧 ffmpeg の既定モノラル化に合わせる約 3 dB の追加増幅は入れない。
- 音源別音量と声の校正を新経路で見直す。
- 旧経路との無補正 RMS 差が 0.5 dB 以内という当初条件は、今回のステレオ素材では満たさない。
  この差は説明済みの仕様差として残す。同じ左右平均を使う参照値との比較は基準内。

同じ音源別音量と master を使うと、今回のステレオ素材は旧経路より約 3 dB 小さくなる。
モノラル素材には同じ差がない。全音源の音量や master を一律に 3 dB 上げる方法は使わない。
多チャンネル素材の旧経路との係数差は未確認。

### 音量と校正の見直し手順

1. Canary で VoiceCord パネルから「音量調整を開く」を開く。
2. 「1. 音源の音量を揃える」で新経路の音源を測る。基準値、推奨音量、上限・ピーク制約を確認する。
3. 移行済みの個別音量は測定だけでは揃え直されない。
   「すべての音源に音量を適用」は既存の個別調整も上書きするため、変更対象を確認して適用する。
4. 音源側の基準を確定してから「声を測る」を行う。測定の 3 秒間は声を出す準備が必要。
5. 希望する「声との差」を選び「この設定にする」で適用する。
6. 受信側で代表的なステレオ音源とモノラル音源を聞き、声とのバランスと音割れを確認する。

根拠は `src/ui/components/LevelDialog.tsx` と `src/ui/lib/calibration.ts`。
測定時に normalizeRefDbfs が更新される。測定画面は完全な読み取り専用ではない。
音源別音量には 150% の上限とピーク制約があり、全音源が基準値へ届くとは限らない。
2026-09-15 にユーザー指定で全 32 音源へ推奨値を適用済み。基準は -16.4 dBFS。
声の再測定はまだ行っていない。変更前後の記録は PROGRESS.md。

## M4 の比較結果

対象: Canary 1.0.1169 / Electron 42.11.2 / ffmpeg 8.1.2-full_build-www.gyan.dev。
差の向きは新経路から参照経路を引いた dB。補正音量を掛ける前の PCM を測った。

| 音源 | 入力 | 旧 ffmpeg 既定との差 | 同じ左右平均との差 |
| --- | --- | ---: | ---: |
| chime.wav | 48000 Hz stereo WAV | -2.988347 dB | -0.000038 dB |
| roblox-death-sound_1.mp3 | 44100 Hz stereo MP3 | -3.010081 dB | +0.000219 dB |
| bye-bye-soundbible.mp3 | 44100 Hz stereo MP3 | -3.010350 dB | -0.000051 dB |
| voice-message.ogg | 48000 Hz mono Opus | +0.008708 dB | +0.008708 dB |

- 旧経路の条件は `-ac 1 -ar 48000 -f f32le`。
  根拠は `../VoiceCord/desktop/src/main/engine/audio.ts` の toF32。
- 同じ左右平均の参照値は、ステレオ入力だけに `-af pan=mono|c0=0.5*c0+0.5*c1` を追加。
  mono 入力には追加しない。多チャンネル入力にそのまま使わない。
- 新経路は Canary の Electron Isolated Context にある実際の window.api から getPcm と sourceStats を取得。
- 両方の PCM を `src/shared/loudness.ts` の measureSamples で測る。
  480 サンプルのブロックごとに絶対 -50 dBFS と相対 -10 dB の二段ゲートを掛ける。
- 比較は RMS 比の常用対数を 20 倍し、絶対値が 0.5 dB 以下かを見る。
- ゲート付き RMS は単純な増幅だけでも採用ブロックが変わる。
  旧 RMS の dB 値に 3.0103 を足すだけで参照値を作らず、左右平均を掛けた PCM を再測定する。
- chime の全サンプル RMS 差は -3.010164 dB。ゲート付きの -2.988347 dB と区別する。

### .wma の実機確認

ffmpeg で 1 秒の 440 Hz 正弦波を実 WMAv2 ファイルとして生成した。
設定済み音源フォルダに一時的に置き、一覧再読込後にタイルを押して確認した。

- 「この形式は再生できません」と Unable to decode audio data がトーストに出た。
- タイルは一覧に残り、再生中は 0 件。engine はアタッチを維持した。
- 検証ファイルを削除し、一覧再読込で検証タイルも消えた。
- 詳細な時系列は TASKS.md。既存の mock decoder テストだけの結果と混同しない。

## M4.5 の実測（純正サウンドボード）

対象: Canary 1.0.1169 / ダークテーマ / Vencord 不在 / DM 通話中。2026-09-14 に CDP で読み取り。
ハッシュ付きのクラス名はビルドごとに変わる。構造と寸法の参考にだけ使い、クラス名を決め打ちしない。

ボタン（音声パネル）:

```
div.container_e131a9
  div.actionButtons_e131a9            334x32（4 ボタンを横に並べる）
    button  78x32  カメラ              名前は直後の span.hiddenVisually
    button  78x32  画面共有
    button  78x32  アクティビティ
    button  78x32  aria-label="サウンドボードを開く"  aria-expanded / aria-controls=popout_N
      div.contents__201d5 buttonContents_e131a9
        div.lottieIcon__5eb9b  18x18（lottie の SVG）
```

ボタンの見た目: padding 7px 15px、r 8px、bg `rgba(151,151,159,0.2)`、
border 1px（ほぼ透明）、font 16px / 500。開いている間だけ `greyButtonActive_e131a9` が付く。

ポップアウト:

```
div.picker__09f65 role=dialog         531x520  r 8px  overflow hidden
                                       shadow: 0 0 0 1px rgba(255,255,255,.08), 0 12px 24px rgba(0,0,0,.24)
  div.header__0856d                    531x64   padding 12px  下辺に elevation-low 相当の影
    検索入力                            471x40   r 8px  bg rgba(0,0,0,.12)  先頭に 16px の虫眼鏡
                                        placeholder「完璧な音を見つけよう」
    歯車 [サウンドボードの音量]          24x24
  div.categoryList                     48x455   bg はポップアウトより一段暗い  左下だけ r 8px
    カテゴリ 32x32 / padding 4px / r 4px（選択中はポップアウト本体の色）
  div.listWrapper role=grid            483x456  縦スクロール（thin）
    セクション見出し                    475x32   padding 0 4px 0 8px  見出し 14px / 600 / muted
    ul.soundRow role=row               gap 8px  padding 0 0 8px 8px
      li.soundButtonWrapper            148x40   r 8px
        div.soundButton                bg rgba(151,151,159,.12)  border 1px 透明
          div.soundInfo                padding 8px  gap 8px  絵文字 + 名前（text-xs/medium）
          div.buttonOverlay            ホバーでプレビュー / お気に入り
```

計測した色（oklab）: ポップアウト本体 0.2452、カテゴリ列とタイルの下地 0.2195。
変数の対応はライトテーマで未確認。

## CDP + Playwright MCP の接続メモ

- Canary を `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223` 付きで起動する。
- Playwright MCP の browser_run_code_unsafe で、渡された page の browserType から connectOverCDP を使う。
  このツールの実行環境では dynamic import が失敗した。require も未定義だった。
- 接続後は URL が `https://canary.discord.com/channels/` で始まるページを選ぶ。
  MCP の通常の page は about:blank なので、Canary へ接続したページと混同しない。
- 主画面の window.api は undefined が正常。実 API は Electron Isolated Context 内だけにある。
- CDP の Runtime.enable で executionContextCreated を取得し、名前から Electron Isolated Context を選ぶ。
  context ID、PID、ウィンドウ ID を次回も同じ値と決め打ちしない。
- Playwright のクリックが FAB に遮られた場合は回帰として記録する。
  force click で通常操作が通ると判定しない。今回の VC ポップアウトは focus と Enter で確認した。
- CDP で確認した未読バッジと DM 本文の受信は、OS 通知バナー・通知音の確認にはならない。

## 再調査が必要になる条件

### CSS 採取と 1 段目発見の修正 2026-09-15

Canary 1.0.1169 の chunk 通知は 4 つの runtime を通った。
先頭の主キャッシュは 9164 件、途中 2 件は c なし、最後の補助キャッシュは 102 件。
従来は最後の require で上書きしていたため主キャッシュ内の CSS を見失っていた。
有効なキャッシュのうち件数が最大のものを保持するよう修正。Vencord 優先経路は維持。

CSS のキー名も uu / x6 / iA のように短縮される。
値の actionButtons_ / button_ / buttonIcon_ と同じハッシュの組み合わせで見分ける。
実測した module ID 187529 とハッシュ e131a9 は調査記録のみ。実装で固定しない。

純正ボタンの単独 div ラッパーも探索対象にする。単独 div の最大 4 段だけをたどり、
任意の子孫探索には広げない。既存の文言・構造確認と自前 UI の除外は維持。
exports の読み取りだけで採取し、モジュールの require 実行・eval・Function.prototype 変更はしない。
getter が副作用を持ちうる既存の制約は残る。Proxy を完全に識別する保証はない。
キャッシュ最大件数の選択はこの実測構成で確認済み。別構成で主キャッシュが最小なら再調査する。

関連 47 テスト、型チェック、ビルド成功。
harvest.js と preload.js / map を配置してハッシュ確認後にページ再読込。
設定表示で webpack 取得済み、1 段目、再挿入 1 回を確認。
engine PID 42140 と注入先 PID 47720 は維持。32000 Hz / 320 サンプルを表示。
harvest.js の map はビルドで生成されないためコピー対象に含めない。
Vencord との新しい実機共存確認は別タスクとして残る。

### 再挿入上限と FAB 非遮蔽 2026-09-15

接ぎ木ボタンの単発削除で自動復帰。40〜45 ms 間隔の反復削除で累計 11 回時点に停止し、
FAB と警告へ切り替わった。初回挿入を含む累計と 1 秒の上限 10 回は区別する。
60 秒後の再試行で接ぎ木へ復帰。2 回目の停止で再試行を繰り返さない動作は既存単体テストで保証。

故障時の FAB は当初 y=665 で純正ポップアウトの中央を遮った。
setFab で Discord の可視操作要素との重なりを読み、表示位置だけ上へ避ける修正を追加。
保存済みの位置と他の Discord 要素は変更しない。上方向の回避は最大 64 回で終了。
画面上端まで操作要素が埋まる特殊な配置では回避保証はない。手動ドラッグは引き続き使える。
修正後 y=620 となり、通常クリックで純正ポップアウトを開閉。FAB 開閉と全停止も確認。
shell 関連 41 テスト・型チェック・ビルド成功。preload を Canary へ反映済み。
検証で変更した DOM はページ再読込で通常状態に復元。スクリーンショット・一時ログは保存していない。

- Discord、Electron、ffmpeg、デコーダ、モノラル化、RMS の計算方法が変わったときは音量比較をやり直す。
- 検証に使った音源ファイルが差し替わった場合も数値を流用しない。
- デコード・ゲート方式が変わったときは、測定キャッシュが内容指紋だけで古い結果を再利用しないか確認する。
- インストール先の dist は今回通常のコピーだった。ビルドだけで実機へ反映されるとは限らない。
  Canary に読み込ませた配布ファイルと payload のハッシュを確認する。
- M3 の engineLost 修正後は再生行が約 40 ms で消え、自動再アタッチは約 4.5 秒で完了した。
  この UI の時間を実際のゲート閉鎖時間として流用しない。受信側の最初の目視報告は約 2 秒。

未確認の残件は TASKS.md を正とする。M4 の声の再測定、M1 の FAB の重なり、
OS 通知・共有映像の受信、24 時間常用、ゲート閉鎖の厳密な 2 秒判定を完了扱いにしない。

## M4.5 の Vencord 共存検証 2026-09-15

ヘッドレス Playwright MCP から Canary の CDP を操作。サブエージェントは使用していない。
Canary の shim を VoiceCord、Vencord の順に一時連鎖した。
再起動時に Canary が 1.0.1169 から 1.0.1171 へ自動更新された。
旧ディレクトリとそこに置いた退避ファイルは削除され、新版には連鎖 shim が残っていた。
旧版をその場で復元できたとする記録は誤りになる。
新版で VoiceCord 単独の shim を生成し、更新前の単独 shim と SHA-256 が一致することを確認して検証をやり直した。

確認できたこと:
- Vencord のメインワールド API と webpack キャッシュが存在する。
- VoiceCord の採取表示は「取得済み、Vencord 経由」。ボタンは 1 段目で発見し、再挿入は 1 回。
- renderer PID 13984、engine PID 28348 に自動アタッチ。32000 Hz、320 サンプルを実測。
- chime のタイルを通常クリックできた。ただし受信側は「聞こえない／音に問題がある」と報告したため音声共存は未合格。
- ライトで明るい背景と暗い文字に追従。ダークへ復元。
- 純正ポップアウトを通常クリックで開き、Discord に戻る操作が成功。ポップアウトの #vc-root は 0 個。

切り分けのため Vencord を外し、VoiceCord 単独へ復元して同じ VC に再入場。
採取表示は webpack 経由へ戻り、renderer PID 48192、engine PID 29536 にアタッチ。
32000 Hz の計測を待って chime を再生し、受信側の回答を待っている。
保存されたモニター出力デバイスが見つからないエラーも起動時に出た。
このエラーはローカル試聴用であり、送信不具合の原因とはまだ断定しない。

復元後の shim SHA-256: `4c9307a3030f1f5fc1a8637d0e634d9c150350110a458be17205fd453dab4591`。
Discord 本体 _app.asar SHA-256: `bd093881364db8d2ed4c69dc667f10d3c3d197636345e5df335c37204fe608bb`。
Stable のプロセス、ファイル、設定は変更していない。

M6 の portable ビルドは `npm run build` と electron-builder が完了した。`dist/VoiceCord-0.1.0-portable.exe` は 2026-09-15 19:56 に更新され、unpacked resources で engine、patcher、preload、harvest、hook、ui と payload/node_modules を確認した。署名処理は環境依存のため自動署名を抑制している。exe 経由で Canary に適用する受け入れは未完了。

二人目参加後の Vencord 共存再検証では、連鎖適用直後の再起動中に Canary が 1.0.1173 へ自動更新し CDP が切断された。受信側の判定前だったため、共存音声の合否には使わない。

その後の共存実機では Vencord 経由の採取とアタッチは成功したが、レートが sampleRate / frameSamples とも未計測で 48 kHz にフォールバックし、受信側で chime が低速・低ピッチになった。`preload/api.ts` は未計測時に Canary の既知値 32000 Hz を選ぶよう変更し、デコードテスト 26 件、型チェック、ビルドに成功。Canary を再起動して新しい preload を読み込み、受信側で速度・ピッチが正常に戻った。

この修正後の全テストは 34 ファイル、485 件が成功した。

portable exe の受け入れで、Canary 1.0.1173 の app.asar は VoiceCord と Vencord の連鎖を実際に持つのに、state.json の 1.0.1169 記録から「更新されて外れています」と誤警告した。`listInstalls` は実物の `active` が true なら staleVersion を立てないよう修正。service テスト 21 件、型チェック、ビルドに成功し、2026-09-15 22:19 に再生成した portable exe で誤警告が消えた。

OS 通知確認用に一般テキストチャンネルへ `@uta_a 通知回帰確認` を送信済み。送信側 Canary で表示を確認。受信側の通知バナー・通知音の評価待ち。
受信側から通知到着の報告を受けた。通知音の有無は未確認。

検証用スクリプトでパス区切りを混在させると、planPatch の samePath が大小文字だけを比較するため
同じ patcher を別の連鎖項目として保持することも分かった。
今回の検証では Windows の正規化した単独パスに揃えて重複を除去した。
製品側のパス比較の修正とテストは別の残件として記録する。

パス比較の残件は `path.win32.normalize` を使う修正で解消した。同じ patcher の `/` と `\\` を同一視する適用テストを追加し、`test/apply.test.ts` の 20 件と型チェックが成功した。
## M5→M6→M7 実機ログ（2026-09-16）

M5 は Canary 1.0.1173 で engine kill 後の自動復帰（failed→starting→searching→attached）と更新再起動を確認した。M6 は portable マネージャーの適用・VoiceCord 単独削除・他 mod 引き継ぎ・全復元を一巡し、同一 payload の再コピー回避と古い branch 記録の除去を追加した。

M7 では Stable 1.0.9257 の renderer/audio に `KrispNCProcessFloat`（48 kHz / 480 samples）が実際に呼ばれることを確認した。chime の校正は 900 frames、clip 0、注入 RMS 0.00697。engine PID 37368 を終了させた後、4.47 秒で PID 37924 に再接続し、修正後の master 2.031588 が再接続後の校正イベントにも残った。

受信側の DOM 上の speaking 表示は今回変化せず、実際に耳で聞こえたことの確認は未取得。したがって送信経路・復帰・音量復元は完了、受信音の人的確認のみ保留とする。
