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
この手順による設定適用と声の再測定はまだ行っていない。旧設定の自動削除・リセットも行っていない。

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

- Discord、Electron、ffmpeg、デコーダ、モノラル化、RMS の計算方法が変わったときは音量比較をやり直す。
- 検証に使った音源ファイルが差し替わった場合も数値を流用しない。
- デコード・ゲート方式が変わったときは、測定キャッシュが内容指紋だけで古い結果を再利用しないか確認する。
- インストール先の dist は今回通常のコピーだった。ビルドだけで実機へ反映されるとは限らない。
  Canary に読み込ませた配布ファイルと payload のハッシュを確認する。
- M3 の engineLost 修正後は再生行が約 40 ms で消え、自動再アタッチは約 4.5 秒で完了した。
  この UI の時間を実際のゲート閉鎖時間として流用しない。受信側の最初の目視報告は約 2 秒。

未確認の残件は TASKS.md を正とする。M4 の声の再測定、M1 の FAB の重なり、
OS 通知・共有映像の受信、24 時間常用、ゲート閉鎖の厳密な 2 秒判定を完了扱いにしない。
