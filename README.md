# 再訪問ノート

個人の再訪問を iPhone の中だけで管理する Web アプリ（ホーム画面に追加して使う PWA）。
サーバー・データベース・ログインは無い。記録は端末の IndexedDB に置き、どこにも送らない。

## できること

- 相手を「人」単位で登録する（呼び名・場所・部屋/階・会衆・言語・都合のよい時間・連絡先・メモ）
- 訪問を回数の制限なく残す（日時・会えた/留守・話したこと・渡したもの・次に話すこと）
- 次の約束で一覧を並べる（約束の日が過ぎた／今日／7日以内／その先／約束なし＝前の訪問が古い順）
- 段階（関心あり・再訪問・聖書レッスン）で色分けし、地図に出す（地理院タイル）
- 位置は「今いる場所」か「地図で選ぶ（十字に合わせる・住所検索）」。位置から町名まで自動で入る
- 会衆で絞る（毎週ちがう会衆を回る使い方を想定）
- 引き継ぎ文を作る（その会衆の奉仕者に渡す文章。連絡先は既定で入れない）
- 次の約束を iPhone のカレンダーに入れる（.ics。通知はカレンダーが出す）
- バックアップの書き出し・読み戻し（パスワードで暗号化できる。読み戻しは同じ記録の新しい方を残す）

## 外に出るもの

| 何を | どこへ | いつ |
|---|---|---|
| 地図の画像の要求（見ている範囲） | 国土地理院（cyberjapandata.gsi.go.jp） | 地図を見たとき |
| 座標 | 国土地理院（逆ジオコーダ） | 位置を決めたとき（町名を出すため） |
| 検索した語 | 国土地理院（住所検索） | 位置を選ぶ画面で探したとき |

名前・メモ・訪問の記録は送らない。

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | 画面の骨組み。iPhone の Safari で開くと「ホーム画面に追加」の案内だけを出す |
| `app.js` | 画面と操作のすべて |
| `store.js` | 端末内の保存（IndexedDB: people / visits / meta） |
| `backup.js` | バックアップファイルの作成・読み込み（AES-GCM＋PBKDF2） |
| `sw.js` | オフラインで開くための控え。見た地図の画像も最大3000枚まで取っておく |
| `muni.json` | 市区町村コード→名前（地理院の muni.js から作った表） |
| `vendor/leaflet/` | Leaflet 1.9.4（オフラインでも動くよう同梱） |
| `icons/` | アイコン。作り直しは `npm run icons` |
| `tools/serve.js` | 手元で開く静的サーバー（`npm run serve` → http://localhost:5181/）。控え（キャッシュ）を使わないので、直したらすぐ画面に出る |
| `.claude/launch.json` | Claude デスクトップの右側の画面（Browser）に、`tools/serve.js` でアプリを出す設定 |
| `.claude/settings.json` | Claude が聞かずに動かしてよいコマンド（試験・commit など）と、必ず聞くコマンド（push＝公開） |
| `tools/dev-harness.js` | 動作試験（`npm test`。ヘッドレス Chrome を iPhone の画面サイズにして一通り操作し、合否と画面写真を出す） |
| `tools/check-version.js` | 公開前の点検（`npm run check`。版の番号・オフライン用の控えの漏れ） |
| `tools/check-private.js` | 個人の情報の点検。commit のたびに、入れようとした中身とメッセージを見て止める |
| `tools/git-hooks/` | 上を commit のときに走らせる仕掛け。`npm ci`／`npm install` のときに自動で有効になる |
| `.github/workflows/deploy.yml` | main に push すると点検・試験し、合格したときだけ完成品を公開用のリポジトリへ送る |
| `tools/public-repo/` | 公開用のリポジトリに置くもの（GitHub Pages に出す workflow と説明）。完成品と一緒に送られる |
| `AGENTS.md` | AI に守らせる決まりごとの原本（Codex などが読む） |
| `CLAUDE.md` / `GEMINI.md` | `AGENTS.md` を読み込むだけ（Claude・Gemini はこちらを読むため） |

## 手元での準備と試験

要るもの: Node.js（22 以上）・Google Chrome・git

```
npm install      # 最初に1回
npm run serve    # 手元で見る
npm run check    # 公開前の点検
npm test         # 動作試験（test-output/ に画面写真）
```

試験は毎回まっさらな Chrome プロファイルで動かすので、本物の端末の記録には触れない。
国土地理院への通信の失敗は「注意」にとどめ、不合格にはしない。

## 公開

リポジトリは2つに分けてある。

| リポジトリ | 見える範囲 | 中身 |
|---|---|---|
| 開発用（ここ） | Private（自分だけ） | ソース・道具・試験・履歴。直すのはここだけ |
| 公開用 | Public | アプリの完成品だけ。GitHub Pages が iPhone に配る |

開発用の main に push すると GitHub Actions が点検と試験をし、合格したときだけ完成品を公開用へ送る。
公開用は受け取るたびに GitHub Pages に出す。公開用を直接直さない（次に送られたときに上書きされる）。

無料プランの GitHub では Private のリポジトリから GitHub Pages を出せないので、この形にしてある。
アプリのファイル（`app.js` など）は、ブラウザに配る以上どうしても誰でも読める。隠れるのは道具・試験・説明と、
プルリクエストや Issue でのやり取り。

### 送り先と鍵（最初に1回だけ）

開発用から公開用へ書き込むための鍵（deploy key）を1組作り、片方ずつ置く。鍵は公開用のリポジトリ1つにしか効かない。

```
ssh-keygen -t ed25519 -N "" -C "revisit-app deploy" -f deploy_key
```

| 置くもの | 置く場所 |
|---|---|
| `deploy_key.pub`（公開鍵） | 公開用の Settings → Deploy keys → Add deploy key。**Allow write access に印を付ける** |
| `deploy_key`（秘密鍵）の中身ぜんぶ | 開発用の Settings → Secrets and variables → Actions → Secrets。名前は `DEPLOY_KEY` |
| 公開用の名前（`ユーザー名/リポジトリ名`） | 開発用の同じ画面の Variables。名前は `PUBLIC_REPO` |

置いたら、手元の2つのファイルは消す。公開用の Settings → Pages → Source は「GitHub Actions」にしておく。
`PUBLIC_REPO` が無いあいだは、点検と試験だけが動き、公開はされない。

### ほかの人に配るとき（配る人だけ）

ソース一式の写しを置く **配布用**（Public）のリポジトリをもう1つ作ると、main が合格するたびに自動で写しが送られる。
受け取る人はそこから clone して、自分の開発用・公開用を作る。配布用では点検と試験だけが動く。

鍵をもう1組作り、公開鍵を配布用の Deploy keys（Allow write access）に、秘密鍵を開発用の Secrets に `DIST_KEY` で、
配布用の名前を開発用の Variables に `DIST_REPO` で置く。

配布用にはソースと commit のメッセージがそのまま出る。プルリクエストや Issue でのやり取りは出ない。

## AI で直す（どのアプリからでも）

どの AI も、リポジトリにある決まりごと（`AGENTS.md`）を読んでから直す。最後の関門は GitHub の試験で、どの AI が直しても同じ。

| 使うもの | 動く場所 | 直したあと |
|---|---|---|
| Claude Code（ターミナル）・Claude デスクトップアプリの Code タブ | 自分の PC | 手元で `npm test` が合格 → main に push |
| Codex CLI・Codex デスクトップアプリ | 自分の PC | 同上 |
| Claude Code on the web（claude.ai/code）・Codex のクラウド | クラウド | ブランチ＋プルリクエスト → GitHub の試験が緑 → マージ |

### Claude デスクトップアプリ（Code タブ）で直す

1. Claude デスクトップアプリを開き、上の **Code** を選ぶ
2. 入力欄の下で **Local**（この PC）と、このフォルダ（`revisit-app`）を選ぶ。**worktree** は選ばない（main のまま直す）
3. モードは **Accept edits**（ファイルの書き換えは聞かずに進める）か **Auto**。慣れるまでは Accept edits
4. 直したいことを日本語で書く。例:「人の詳細画面で、電話番号を押したら電話をかけられるようにしたい」
5. Claude が直すと、右側の **Browser** にアプリが出て、Claude が自分で触って確かめる（PC の画面なので iPhone より横に広い）
6. 試験が合格すると Claude が commit し、**push してよいか聞いてくる。これを許すと公開される**（数分後に iPhone に「更新する」が出る）

試験・commit は聞かずに動いてよい設定、push（公開）は必ず聞く設定、強制 push と `git reset --hard` は動かせない設定にしてある（`.claude/settings.json`）。

クラウドの AI にリポジトリを使わせるには、それぞれの画面で GitHub とつなぐ（初回だけ）。
依存の準備は `npm ci`。クラウドでは Chrome が無く `npm test` が動かないことがあるが、GitHub の試験が代わりに通す。

## 版を上げるとき

`sw.js` の `VERSION` と `app.js` の `APP_VERSION` を両方上げる。
`sw.js` の中身が変わらないと、iPhone は古い版を使い続ける。
新しい版が届くと画面の上に「新しい版があります［更新する］」が出る（押すまで切り替えない）。

## 個人の情報を入れない仕掛け

開発用のリポジトリは Private だが、アプリのファイルはそのまま公開用へ送られ、直すときは AI にも渡る。訪問先の方の名前・住所・事情は、記録される側が同意したものではないので、
**git には一切入れない。** 一度 push すると履歴から消せない（fork や各種の控えにも残る）。

アプリの作りの上では、記録は iPhone の IndexedDB の中だけにあり、git に入る理由がない。
そのうえで、うっかり入れてしまう事故を機械的に止めてある。

| 止める場所 | 何を止めるか |
|---|---|
| `.gitignore` | 書き出したバックアップ、`test-output/` の画面写真、一番上の階層の見慣れない JSON |
| `pre-commit` | これから commit する中身。バックアップは**名前を変えて置かれても中身で**見分ける。電話番号・番地まで入った住所・メールアドレスも止める |
| `commit-msg` | commit のメッセージに入った実在の人の名前（「◯◯さんの…」）・電話・住所 |
| `npm run check` | いま git に入っているファイル全部。GitHub の点検でも走るので、クラウドの AI が直したときも通る |
| `.claude/settings.json` | AI が点検を避ける操作（`git add -f`・`git commit --no-verify`・`core.hooksPath` の変更）を禁じる |

`pre-commit` と `commit-msg` は `npm ci`／`npm install` のときに自動で有効になる（`tools/install-hooks.js`）。
自分で入れ直すときは `git config core.hooksPath tools/git-hooks`。

止まったときは、入れてしまったファイルを `git restore --staged <ファイル>` で外す。
町名まで（例: 小倉北区城内）は公の地名なので止めない。番地や部屋番号まで書かれていると止まる。
**人が自分の判断で通すときだけ** `git commit --no-verify`（AI は使えない設定にしてある）。

運用で気をつけることが一つだけある。**AI に相談するときも実在の名前を打ち込まない。**
「◯◯さんの記録が消えた」ではなく「記録が消えた」と書けばよい。名前は直すのに要らない。

## 注意

- **公開する URL を後から変えない。** 公開用のリポジトリの名前を変えない・Private にしない・消さない。端末内の記録は URL（オリジン）ごとに分かれていて、変えると前の記録が見えなくなる。
  変えるときは、古い URL でバックアップを書き出し、新しい URL で読み戻す
- iPhone ではホーム画面のアイコンから開く。Safari とホーム画面のアプリでは保存場所が別
- ホーム画面のアイコンを削除すると、記録も一緒に消える
