# mask2gemini — SPEC

## 目的

非エンジニアが、社内 Web アプリの画面から UI 改善モックを Gemini（gemini.google.com / Canvas）に作らせる際の**前処理**を行う Chrome 拡張（Manifest V3）のプロトタイプ。

パイプライン: **スクリーンショット撮影 → テキスト抽出（DOM 直接読み取り。不可なら OCR に自動フォールバック）＋決定的ルールで PII/データ領域を自動マスク → 目視確認・手動修正 → マスク済み画像とプロンプトをクリップボードへ → Gemini を新規タブで開く**

## スコープ外

- Gemini API による直接送信・Web UI の自動操作
- Chrome ウェブストアへの配布、他ブラウザ対応
- プロジェクト別セレクタ設定
- ホワイトリストのネットワーク経由の自動同期（共有 URL 取得・chrome.storage.managed）。チーム共有は JSON ファイルの受け渡しで行う

## 確定事項（再議論禁止）

1. **マスキング判定に LLM を使わない**（オンデバイス LLM 含む）。判定はテキスト抽出（DOM または OCR）＋正規表現＋アローリスト型ルールのみの決定的処理とする
2. **recall 優先（塗りすぎ許容）**。「PII を検出して塗る」ではなく「データらしきテキストは中身を問わず塗る」アローリスト型を基本とする
3. **目視確認ステップ必須**。自動マスク後にユーザーが確認し、ドラッグで追加マスク・クリックで解除できる。確定操作なしに画像を書き出さない
   recall優先（確定事項2）で大量にマスクされたときの後処理負荷を下げるため、Shift+ドラッグで矩形内のマスクを一括解除できる（表内の日付列やメールが列挙されたメニュー等、1件ずつのクリックが煩雑なケースの救済。個別クリック解除と異なりホワイトリスト登録の提示は行わない）
4. **Gemini への受け渡しは自動化しない**。クリップボードへのコピーと gemini.google.com のタブを開くまで
5. **マスキング前の画像・テキストを端末外へ送信しない**。OCR はローカル（tesseract.js / WASM）で実行し、外部リクエストを発生させない
6. 技術構成は**バニラ JS・ビルドなし**。`chrome://extensions` から直接読み込める形を維持する
7. 依存パッケージのバージョンは記憶で書かず `bun add` で導入する
8. **ユーザーホワイトリスト（マスクしない語句）は自動ルールより優先する**。保存先は `chrome.storage.local`、照合は正規化（空白除去・全角半角統一・小文字化）後の行テキストに対するフレーズ部分一致で行い、一致範囲に重なる単語のマスクを解除する
9. **テキスト抽出は DOM 直接読み取りを優先し、不可なら OCR に自動フォールバックする（Issue #13）**。経路選択の UI は設けない（非エンジニアの手数を増やさない）。マスクを載せる画像は両経路とも `captureVisibleTab` のスクリーンショットで、確認 UI・出力導線は完全共通。どちらの経路を使ったかは確認画面のステータスに表示する
10. **DOM 経路で中身を読めない領域は領域ごと自動マスクする（丸塗り）**。cross-origin iframe・closed shadow DOM・`<canvas>`・`<img>` 等、矩形は取れるがテキストを抽出できない領域は、recall 優先（確定事項 2）に従い全面を塗る。不要なら目視確認ステップでクリック / Shift+ドラッグで解除する
11. **DOM 特有の構造判定は要素種別レベルに留める（v1）**。`<th>` `<label>` `<caption>` `<legend>` ボタン類・`aria-label` 等 → ラベルとして残す方向の保護、`<td>`・フォーム入力値等 → データ扱い。カラム単位判定（「ヘッダが氏名の列は列ごと塗る」等）は次段とする。テキスト面の判定（judge / judgeToken）は両経路で共通に使う

## アーキテクチャ

```
mask2gemini/
├── SPEC.md
├── extension/               ← chrome://extensions で読み込むディレクトリ
│   ├── manifest.json        MV3。permissions: activeTab, tabs, clipboardWrite, storage, scripting
│   ├── background.js        service worker。アイコンクリック → captureVisibleTab ＋
│   │                        scripting.executeScript で dom-extractor を注入（同一クリック内で
│   │                        連続実行し座標ズレを防ぐ）→ 結果を chrome.storage.session に
│   │                        保存 → review.html を開く。注入失敗時は OCR フォールバック用の
│   │                        フラグを残す
│   ├── dom-extractor.js     注入される抽出器。viewport 内のテキストノードを走査し
│   │                        {text, bbox(CSS px), semantic} 列と「読めない領域」の矩形列を
│   │                        返す。判定はしない（意味情報の収集まで）
│   ├── review.html / review.js / review.css
│   │                        確認画面。canvas に画像表示 → DOM 抽出結果があればそれを
│   │                        units に変換、なければ OCR → ルール適用で自動マスク
│   │                        → 手動編集（ドラッグ追加・クリック解除・Shift+ドラッグ一括解除）
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

### DOM 抽出経路（Issue #13・優先経路）

判定パイプラインは units 配列（`{text, bbox, token, confidence}`）を受ける
`decideParagraphMasks`（mask-decider.js）で抽出元に非依存に抽象化済み。
DOM 経路は OCR の `lineToUnits` に相当する変換（`domToUnits`）を差し替えるだけで、
判定・確認 UI・ホワイトリスト・出力導線は OCR 経路と完全共有する。

- **抽出**: background.js が `chrome.scripting.executeScript`（`activeTab` 由来の一時
  ホスト権限＋ `scripting` permission。`host_permissions` は追加しない）で
  dom-extractor.js を注入。viewport 内のテキストノードごとに
  テキスト・`getBoundingClientRect`（CSS px）・意味情報
  （タグ名、`th`/`td`/`label`/`caption`/`legend`/ボタン類/`aria-label` 等の別、
  フォーム入力値か否か）を収集する
- **座標変換**: CSS px → 画像 px の係数は「capture 画像幅 ÷ viewport 幅」で算出
  （devicePixelRatio・ページズームをまとめて吸収）。OCR 経路の `OCR_SCALE` 割り戻しに相当
- **形態素解析**: kuromoji は拡張ページでのみロードできるため、tokenize は
  review.js 側で行う（現行と同じ場所）。DOM テキストは原文そのものなので
  OCR 経路より品詞・未知語判定の精度が上がる
- **confidence**: DOM 経路では常に 100 とする（NOISE_CONFIDENCE フィルタは実質無効。
  誤認識ノイズという概念自体がない）。折り返し断片の行結合
  （findLinePatternMaskIndices / block 結合）も原文が取れるため不要
- **要素種別判定（確定事項 11）**: ラベル系要素は「残す」方向の保護として
  UI ラベル辞書（fullCoverage 照合）と同系統に扱い、データ系要素
  （`td`・フォーム入力値）は digit / at-mark と同様の data-like としてラベル保護を
  バイパスする。ユーザーホワイトリストが常に最優先（確定事項 8）である点は不変
- **読めない領域（確定事項 10）**: cross-origin iframe・closed shadow DOM・
  `<canvas>`・`<img>` は矩形ごと自動マスク（`source: "auto", reason: "opaque-region"` 等）。
  装飾アイコン等の誤爆は目視確認ステップの一括解除で救済する
- **フォールバック条件**: 注入不可（`chrome://`・PDF ビューア・ウェブストア等）、
  抽出器の実行時エラー、結果が空。このとき従来どおり OCR 経路で処理し、
  確認画面のステータスに使用経路を表示する

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
- DO: 画像・抽出テキスト（OCR / DOM とも）の保持は `chrome.storage.session`（ブラウザ終了で消える）に限定する
- DO NOT: 外部 CDN・外部 API へのリクエストを行うコードを書かない
- DO NOT: マスク前画像をダウンロードフォルダ等へ書き出さない
- DO NOT: gemini.google.com の DOM を操作しない

## 検証手順（E2E）

1. `bun install && bash scripts/copy-vendor.sh` で `extension/vendor/` が生成されること
2. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `extension/` を読み込めること（エラーなし）
3. `test/fixture.html` をブラウザで開き、拡張アイコンをクリック → 確認画面が新規タブで開き、スクリーンショットが表示されること
4. OCR 完了後、fixture 内のメールアドレス・電話番号・氏名・テーブルのデータセルに自動マスクが載ること（UI ラベル「保存」「検索」等は塗られないこと）
5. ドラッグで手動マスクを追加でき、既存マスクをクリックで解除できること。Shift+ドラッグで矩形内の既存マスクをまとめて解除できること
6. 「画像をコピー」→ 任意の画像貼り付け先（Gemini 入力欄等）に PNG として貼れること
7. 「プロンプトをコピー」→ テキストとして貼れること。「Gemini を開く」→ gemini.google.com が新規タブで開くこと
8. DevTools の Network タブで、確認画面の処理中に外部リクエストが発生していないこと
9. 設定画面で「株式会社ABC」「山田 太郎」を登録 → fixture を撮り直すと該当箇所（空白の有無・単語分割によらず）が塗られないこと
10. 確認画面で自動マスクをクリック解除した際に「次回からマスクしない」ボタンが出て、登録すると設定画面に反映されること
11. JSON エクスポート → 別プロファイル/環境でインポート → 登録語句が追記されること
12. 辞書登録なしで氏名・地名（山田太郎・東京都新宿区等）が塗られ、見出し・ラベル（顧客管理システム・メールアドレス・契約金額等）が残ること
13. （DOM 経路）http(s) で開いた fixture では DOM 経路が使われ、ステータスにその旨が
    表示されること。`<th>`・`<label>` 等のラベルが残り、`<td>`・入力値が塗られること。
    マスク矩形が実際の文字位置とずれていないこと（ズーム 100% 以外でも）
14. （フォールバック）`chrome://version` 等の注入不可ページや PDF では OCR 経路に
    自動で切り替わり、エラーにならないこと
15. （読めない領域）cross-origin iframe / `<canvas>` / `<img>` を含むページで、該当領域が
    丸塗りされること。Shift+ドラッグで一括解除できること

注: `chrome.scripting.executeScript` は `file://` ページでは拡張の「ファイルの URL への
アクセスを許可」が必要。E2E で fixture を DOM 経路に通す場合はローカル http サーバで
配信するか、Playwright 側で該当フラグを有効化する（実装時に確認）。

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
9. DOM 抽出の配管: manifest に `scripting` 追加、background.js で撮影＋抽出器注入を
   連続実行し結果を storage.session へ。注入失敗時のフォールバックフラグ
10. dom-extractor.js: viewport 内テキストノード走査 → {text, bbox, semantic} 列＋
    読めない領域の矩形列。判定を含まない収集専用モジュールとして書く
11. review.js の経路分岐: DOM 結果があれば `domToUnits` → `decideParagraphMasks`
    （confidence=100・座標係数=画像幅÷viewport幅）、なければ従来の OCR 経路。
    使用経路のステータス表示
12. 要素種別判定: ラベル系保護／データ系 data-like 扱いを mask-decider 側に統合し、
    node:test で単体テスト（semantic 付き units を渡すだけなので DOM 不要）
13. 読めない領域の丸塗り＋DOM 経路の E2E（既存 fixtures を http 配信で流用、
    フォールバック経路の回帰確認を含む）
