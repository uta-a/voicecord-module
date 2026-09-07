# Discord が起動しなくなったときの復旧手順

VoiceCord は Discord の `app.asar` を差し替えて動く。差し替えに失敗したり、
Discord の更新と噛み合わなかったりすると Discord が起動しなくなることがある。

**この手順は VoiceCord.exe が起動できなくても実行できる。** 手作業だけで元に戻せる。

---

## 手順

対象のフォルダはパッチを当てたビルドによって変わる。

| ビルド | エクスプローラのアドレス欄に貼るパス |
|---|---|
| Discord Stable | `%LOCALAPPDATA%\Discord` |
| Discord Canary | `%LOCALAPPDATA%\DiscordCanary` |
| Discord PTB | `%LOCALAPPDATA%\DiscordPTB` |

1. **タスクマネージャで Discord を全部終了する。**
   「詳細」タブで `Discord.exe`（Canary なら `DiscordCanary.exe`）を探し、
   複数出てくるので全部終了する。1 つでも残っているとファイルを差し替えられない。

2. エクスプローラのアドレス欄に上の表のパスを貼って Enter。

3. `app-1.0.xxxx` というフォルダが並んでいるので、**一番新しいもの**を開き、
   その中の `resources` を開く。
   数字は文字列ではなく数として比較する（`1.0.1099` は `1.0.999` より新しい）。

4. `_app.asar`（先頭にアンダースコア）があることを確認する。
   - **ある** → 手順 5 へ
   - **ない** → 手順 8 へ

5. `app.asar` を削除する。
   これは数百バイト〜数 KB の小さいファイルのはず。もし 3 MB 以上あるなら
   それは Discord 本体なので削除してはいけない（手順 8 へ）。

6. `_app.asar` を `app.asar` にリネームする（先頭の `_` を消す）。

7. Discord を起動する。ここまでで素の Discord に戻っている。

8. それでも直らない場合は Discord をアンインストールして入れ直す。
   **設定・ログイン情報・サーバーは `%APPDATA%\discord` に残るので消えない**
   （Canary なら `%APPDATA%\discordcanary`）。

---

## 注意

**手順 6 を実行すると、Vencord など他の mod も同時に外れる。**
`app.asar` は 1 つしかなく、VoiceCord と Vencord はそこを連鎖して共有しているため。

Vencord を戻すには、Vencord Installer をもう一度実行して Inject する。
その後 VoiceCord を使いたい場合は、VoiceCord.exe から「適用」をやり直す
（Vencord を検出して自動的に連鎖に組み込む）。

---

## 症状別の見分け方

| 症状 | 原因 | 対処 |
|---|---|---|
| Discord が起動しない／すぐ落ちる | `app.asar` の差し替えに失敗した | 上の手順 1〜7 |
| Discord は起動するが VoiceCord のボタンが出ない | パッチが外れた（Discord の更新、Vencord Installer の再実行など） | VoiceCord.exe から「再適用」 |
| ボタンは出るが赤い | パッチは当たっているがエンジンが動いていない | ボタンを押してパネルを開くと理由が読める |
| Discord は起動するが Vencord が効かない | 連鎖から Vencord が抜けた | VoiceCord.exe から「再適用」 |

**「ボタンが出ているかどうか」がそのままパッチ状態を表す。**
音が鳴らないときは、まず Discord の画面にボタンがあるかを見る。

---

## 手動で状態を確認する

`resources` フォルダの中身で判断できる。

| `app.asar` のサイズ | `_app.asar` | 状態 |
|---|---|---|
| 3 MB 以上 | なし | 素の Discord（未パッチ） |
| 数百バイト〜数 KB | あり（3 MB 以上） | 何らかの mod が入っている |
| 3 MB 以上 | あり | **異常**。手順 5〜7 で戻す |
| 数百バイト〜数 KB | なし | **異常**。Discord 本体が失われている。手順 8 |

`app.asar` が小さい場合、メモ帳などで開くと先頭に
`VoiceCord chain shim` という文字列が見える。これがあれば VoiceCord が
管理している shim で、続く `CHAIN` の配列に読み込まれる mod の一覧が入っている。
