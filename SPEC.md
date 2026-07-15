# mask2gemini — SPEC

## 目的

非エンジニアが、社内 Web アプリの画面から UI 改善モックを Gemini（gemini.google.com / Canvas）に作らせる際の**前処理**を行う Chrome 拡張（Manifest V3）のプロトタイプ。

パイプライン: **スクリーンショット撮影 → OCR＋決定的ルールで PII/データ領域を自動マスク → 目視確認・手動修正 → マスク済み画像とプロンプトをクリップボードへ → Gemini を新規タブで開く**

## スコープ外

- DOM 事前マスキング層（次段で追加する想定。プロトタイプは OCR 層のみ）
- Gemini API による直接送信・Web UI の自動操作
- Chrome ウェブストアへの配布、他ブラウザ対応
- プロジェクト別セレクタ設定
- ホワイトリストのネットワーク経由の自動同期（共有 URL 取得・chrome.storage.managed）。チーム共有は JSON ファイルの受け渡しで行う

## 確定事項（再議論禁止）

1. **マスキング判定に LLM を使わない**（オンデバイス LLM 含む）。判定は OCR＋正規表現＋アローリスト型ルールのみの決定的処理とする
2. **recall 優先（塗りすぎ許容）**。「PII を検出して塗る」ではなく「データらしきテキストは中身を問わず塗る」アローリスト型を基本とする
3. **目視確認ステップ必須**。自動マスク後にユーザーが確認し、ドラッグで追加マスク・クリックで解除できる。確定操作なしに画像を書き出さない
4. **Gemini への受け渡しは自動化しない**。クリップボードへのコピーと gemini.google.com のタブを開くまで
5. **マスキング前の画像・テキストを端末外へ送信しない**。OCR はローカル（tesseract.js / WASM）で実行し、外部リクエストを発生させない
6. 技術構成は**バニラ JS・ビルドなし**。`chrome://extensions` から直接読み込める形を維持する
7. 依存パッケージのバージョンは記憶で書かず `bun add` で導入する
8. **ユーザーホワイトリスト（マスクしない語句）は自動ルールより優先する**。保存先は `chrome.storage.local`、照合は正規化（空白除去・全角半角統一・小文字化）後の行テキストに対するフレーズ部分一致で行い、一致範囲に重なる単語のマスクを解除する

## アーキテクチャ

```
mask2gemini/
├── SPEC.md
├── extension/               ← chrome://extensions で読み込むディレクトリ
│   ├── manifest.json        MV3。permissions: activeTab, tabs, clipboardWrite, storage
│   ├── background.js        service worker。アイコンクリック → captureVisibleTab
│   │                        → 画像を chrome.storage.session に保存 → review.html を開く
│   ├── review.html / review.js / review.css
│   │                        確認画面。canvas に画像表示 → OCR → ルール適用で自動マスク
│   │                        → 手動編集（ドラッグ追加・クリック解除）
│   │                        → 「画像をコピー」「プロンプトをコピー」「Gemini を開く」
│   ├── rules.js             決定的マスキングルール（下記）
│   ├── allowlist.js         ユーザーホワイトリスト（storage.local 入出力・フレーズ照合）
│   ├── mask-decider.js      OCR結果→マスク矩形への変換（DOM/chrome API非依存の純関数。
│   │                        review.js と node:test の両方から呼ばれる）
│   ├── *.test.js            rules.js/allowlist.js/mask-decider.js の単体テスト（node:test）
│   ├── options.html / options.js / options.css
│   │                        設定画面。語句の追加・削除、JSON エクスポート/インポート
│   │                        （チーム共有はこの JSON をリポジトリ等で受け渡す）
│   └── vendor/              copy-vendor.sh が生成（git 管理外）
│       ├── tesseract/ core/ OCR (tesseract.js) 一式
│       ├── lang/            jpn / eng の traineddata
│       └── kuromoji/        形態素解析（kuromoji.js + IPADIC 辞書、ローカル実行）
├── scripts/copy-vendor.sh   node_modules → vendor/ へのコピーと traineddata 取得
├── test/fixture.html        ダミー PII 入りのテストページ（E2E 用）
├── test/fixtures/           エッジケース別の追加フィクスチャ（下記）
├── test/e2e/mask.spec.js    Playwright E2E（拡張を実際に読み込み実OCRで検証）
├── playwright.config.js
└── package.json             tesseract.js・@playwright/test 等（bun add で導入）
```

### マスキングルール（rules.js・決定的）

判定単位は **形態素トークン**。OCR は精度向上のため画像を拡大（OCR_SCALE 倍）してから実行し、
行テキストを kuromoji.js（IPADIC 辞書同梱・ローカル実行）で形態素解析して、
文字（symbol）の bbox からトークン単位の矩形を組み立てる。
kuromoji が読み込めない環境では OCR 単語単位の判定にフォールバックする。

トークンごとに以下で判定し、いずれかに該当したら塗る（judgeToken）:

- 定型 PII（数字・@ を含む）/ 一定文字数以上
- **品詞が固有名詞**（人名・組織・地名。辞書登録なしで検出できる）/ 数詞
- **未知語**（辞書に無い語 = 名前・ID・造語の可能性。記号は除く）

フォールバック時（judge）は従来どおり:

- ブロックリスト（定型 PII）: メールアドレス / 電話番号らしき数字列 / 郵便番号 / カード番号らしき数字列 / 日付らしき文字列
- アローリスト型（データらしさ）: 数字を含む / `@` を含む / 一定文字数以上の連続文字列 / 漢字・カナの人名になり得る 2〜4 文字語のうち UI ラベル語彙（「保存」「検索」「一覧」等の同梱辞書）に**該当しないもの**

失敗は「塗りすぎ」方向にのみ倒す。閾値・辞書は rules.js 内の定数として編集可能にする。

トークン単体の判定に加え、**行（ブロック）結合パターン照合**（rules.js の
`LINE_PATTERNS` / `findLinePatternMaskIndices`）を行う（Issue #1）。トークン分割で
断片化すると単体では無害に見える断片（メールの短いドメイン末尾、電話番号の
区切り記号 `-` `(` 等）を、結合文字列へのパターン一致（email / digit-run =
数字2個以上を区切り文字で繋いだラン）でまとめて塗る。一致範囲が同一行内で
連続する場合はトークン間の空白ごと 1 つのマスク矩形にマージする（桁のまとまりが
読み取れる塗り残しを防ぐ。折り返しで別の OCR 行に分かれた断片は行ごとに分割）。
この判定は個別トークンの
信頼度フィルタ（NOISE_CONFIDENCE）・組み込みラベル辞書の保護より優先する
（ユーザーホワイトリストのみが勝つ。Issue #3 の恒久方針）。

OCR は日本語を語彙と異なる単位（「保|存」「メール|アドレス」等）に分割するため、
アローリスト辞書の適用は単語の完全一致ではなく**行単位のフレーズ照合**で行う。
組み込み辞書は「単語の全文字が一致範囲で覆われた場合のみ」保護（fullCoverage）とし、
データ中の社名等への部分一致（例:「会社」→「株式会社◯◯」）で断片が解除されるのを防ぐ。
また数字・@ を含む語は組み込み辞書では保護しない。ユーザーホワイトリストのみ、
一致範囲に重なる単語を無条件に保護する（確定事項 8）。

### CSP / ローカル実行の担保

- `manifest.json` の `content_security_policy.extension_pages` に `wasm-unsafe-eval` を含め、tesseract.js の WASM をローカル実行する
- tesseract.js の `workerPath` / `corePath` / `langPath` はすべて `vendor/` 配下を指す。CDN フォールバックを無効化し、ネットワークへ出る設定を残さない

## DO / DO NOT

- DO: tesseract.js の API はドキュメント（同梱ドキュメント→Context7）で確認してから書く
- DO: 各タスク完了時に `node --check` 等の静的検証と、可能な範囲の動作検証を行う
- DO: 判定ロジック（rules.js / allowlist.js / mask-decider.js）を変更したら
      `bun run test`（単体テスト）→ `bun run test:e2e`（実OCRのE2E）の順で確認する
      （README.md「検証プロセス」参照）。単体テストは秒未満で終わるので必ず通す。
      E2E は実ブラウザ・実OCRを使うため OCR 由来の不具合（行/段落分割の癖等）は
      ここでしか再現できない
- DO: 画像・OCR テキストの保持は `chrome.storage.session`（ブラウザ終了で消える）に限定する
- DO NOT: 外部 CDN・外部 API へのリクエストを行うコードを書かない
- DO NOT: マスク前画像をダウンロードフォルダ等へ書き出さない
- DO NOT: gemini.google.com の DOM を操作しない

## 検証手順（E2E）

1. `bun install && bash scripts/copy-vendor.sh` で `extension/vendor/` が生成されること
2. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `extension/` を読み込めること（エラーなし）
3. `test/fixture.html` をブラウザで開き、拡張アイコンをクリック → 確認画面が新規タブで開き、スクリーンショットが表示されること
4. OCR 完了後、fixture 内のメールアドレス・電話番号・氏名・テーブルのデータセルに自動マスクが載ること（UI ラベル「保存」「検索」等は塗られないこと）
5. ドラッグで手動マスクを追加でき、既存マスクをクリックで解除できること
6. 「画像をコピー」→ 任意の画像貼り付け先（Gemini 入力欄等）に PNG として貼れること
7. 「プロンプトをコピー」→ テキストとして貼れること。「Gemini を開く」→ gemini.google.com が新規タブで開くこと
8. DevTools の Network タブで、確認画面の処理中に外部リクエストが発生していないこと
9. 設定画面で「株式会社ABC」「山田 太郎」を登録 → fixture を撮り直すと該当箇所（空白の有無・単語分割によらず）が塗られないこと
10. 確認画面で自動マスクをクリック解除した際に「次回からマスクしない」ボタンが出て、登録すると設定画面に反映されること
11. JSON エクスポート → 別プロファイル/環境でインポート → 登録語句が追記されること
12. 辞書登録なしで氏名・地名（山田太郎・東京都新宿区等）が塗られ、見出し・ラベル（顧客管理システム・メールアドレス・契約金額等）が残ること

### 追加フィクスチャ（エッジケース）

`test/fixtures/` は `test/fixture.html` を補う、特定の失敗パターンに絞った E2E 用ページ。
過剰マスク・塗り漏れの回帰確認に使う。開き方・確認手順は基本フィクスチャと同じ
（アイコンクリック→確認画面→自動マスクを目視）。

- `email-wrap.html`: 狭いカード幅・テーブル幅でメールアドレスが視覚的に複数行へ
  折り返される、短いドメイン（`n@ab.co` 等）。すべてのメール断片が塗られること
  （行結合パターン照合 `findLinePatternMaskIndices` の確認用）
- `unknown-ui-labels.html`: `UI_LABEL_ALLOWLIST`（rules.js）に無い一般的な UI ラベル
  （「並び替え条件」「Sync Status」等）。PII ではないため、過剰マスクされた場合は
  辞書追加やヒューリスティック判定の要否を検討する材料にする
- `phone-postal-formats.html`: 電話・郵便番号の表記ゆれ（全角数字・かっこ・
  国番号・内線・フリーダイヤル）。数字トークンは digit ルール、間の区切り記号
  （`-` `(` `)` 全角ハイフン等）は行結合の digit-run パターン（Issue #1）で
  ラン全体として塗られること、桁・区切りの一部だけ塗り漏れないことを確認する
- `noise-borders.html`: 装飾的な二重罫線・box-shadow・アイコン・薄い文字色。
  「UI 部品の誤認識で塗られる」バグ（NOISE_CONFIDENCE 導入の元ネタ）の回帰確認用
- `dashboard.html`: KPI カード・棒グラフ・ステータステーブルを含む運用ダッシュボード。
  数値は recall 優先で塗られてよいが、見出しラベル（「月間アクティブユーザー」等）が
  残ること、罫線的な要素（棒グラフのバー等）を文字として誤認識しないことを確認する

## タスク分解

1. 雛形: ディレクトリ構成、manifest.json、background.js（撮影→review 起動）、空の review 画面
2. vendor 導入: `bun add tesseract.js`、copy-vendor.sh（dist・WASM・traineddata）
3. OCR＋ルールエンジン＋自動マスク描画
4. 手動マスク編集 UI（ドラッグ追加・クリック解除）
5. 出力: 画像コピー / プロンプトコピー / Gemini タブ
6. test/fixture.html 作成と E2E 検証
7. ユーザーホワイトリスト: allowlist.js（照合ロジック＋storage）、options ページ（追加・削除・JSON 入出力）、確認画面からの登録導線
8. OCR 精度改善: 拡大前処理（OCR_SCALE）＋形態素解析層（kuromoji.js・品詞ベース判定・フォールバック付き）
