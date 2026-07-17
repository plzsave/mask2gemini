# mask2gemini

スクリーンショットを決定的ルール（LLM 不使用）でマスクし、Gemini にモック作成を依頼する前処理を行う Chrome 拡張（Manifest V3）のプロトタイプ。テキスト抽出はページの DOM を直接読むのが基本で、読めないページ（PDF・chrome:// 等）では OCR に自動フォールバックする。仕様は [SPEC.md](./SPEC.md) を参照。

## セットアップ

```bash
bun install
bash scripts/copy-vendor.sh   # extension/vendor/ を生成（tesseract.js 一式・言語データ）
```

1. `chrome://extensions` を開き、右上の「デベロッパーモード」を有効化
2. 「パッケージ化されていない拡張機能を読み込む」で `extension/` ディレクトリを選択

## 使い方

1. マスクしたい画面のタブで拡張アイコンをクリック
2. 確認画面が開き、解析完了後に自動マスクが表示される（通常はページ構造の解析で即座に完了。OCR フォールバック時は文字認識の進捗が出る）
   - 黒塗りをクリック → 解除／余白をドラッグ → 手動マスク追加
3. 「① マスク済み画像をコピー」→「③ Gemini を開く」→ 入力欄に貼り付け
4. 「② プロンプトをコピー」→ 要望部分を書き換えて送信

## ホワイトリスト（マスクしない語句）

拡張の「設定」（確認画面右上の「設定」ボタン、または chrome://extensions のオプション）から、自社名・自分の名前など**マスクしない語句**を登録できる。自動ルールより優先され、空白を無視して照合される（「山田 太郎」は「山田太郎」にも一致）。確認画面で自動マスクをクリック解除したときも、その場で登録できる。

チーム共有は、設定画面の **JSON エクスポート/インポート**で行う。エクスポートした `mask2gemini-allowlist.json` を共有リポジトリ等に置き、各メンバーがインポートする（既存登録への追記・重複は自動除外）。

## チューニング

判定は形態素トークン単位（kuromoji.js・ローカル実行）で行い、**固有名詞（人名・地名・組織名）と未知語は辞書登録なしで塗られる**。加えて `extension/rules.js` の定数（アローリスト辞書・文字数閾値・正規表現）で調整できる。判定は recall 優先（迷ったら塗る）に倒してある。数字は原則すべて塗られるが、単位（`%`・`ms`・`件`・`人`・`回`・`分`・`秒`）が直接くっついた指標値（`99.95%`・`182ms` 等）だけは例外として残る（ダッシュボードの KPI 対策。単位リストは `extension/rules.js` の `UNIT_METRIC_RE` で調整できる。金額・日付の単位は意図的に含めていない）。OCR フォールバック時は精度向上のため画像を2倍に拡大してから実行する。

DOM 経路では要素種別も判定に使う: `th`/`label`/ボタン類などのラベルは残り、`td`/フォーム入力値はデータとして塗られる。中身を読めない領域（別オリジンの iframe・`canvas`・一定サイズ以上の画像）は丸ごと塗られる（不要なら確認画面で解除）。判定対象の要素種別・サイズ閾値は `extension/dom-extractor.js` の定数で調整できる。

## 別環境への配布

```bash
bash scripts/package.sh   # dist/mask2gemini-<version>.zip を生成
```

zip を渡した先では、展開して `chrome://extensions`（デベロッパーモード）→「パッケージ化されていない拡張機能を読み込む」で `extension/` を選ぶだけ。git・bun は不要。

## 検証プロセス

判定ロジック（rules.js / allowlist.js / mask-decider.js）を変更したら、次の順で確認する。

### 1. 単体テスト（高速・毎回実行）

```bash
bun run test   # node:test 互換。DOM/OCR/chrome API 不要、数十ms で終わる
```

`extension/*.test.js` に判定ロジックの純関数テストがある。ここでロジックの
リグレッションを潰してから E2E に進む。

### 2. E2E テスト（実ブラウザ。OCR / DOM 両経路）

```bash
npx playwright install chromium   # 初回のみ
bun run test:e2e
```

Playwright でヘッドレス Chromium に拡張機能を実際に読み込み、`test/fixture.html` /
`test/fixtures/*.html` を撮影 → テキスト抽出（OCR、および DOM 経路は
dom-extractor.js を fixture 内で評価）→ 自動マスクまでフルパイプラインで実行し、
結果の canvas をピクセルサンプリングして「塗られるべき要素が黒塗りされているか」
「残るべき要素が変化していないか」を検証する（`test/e2e/mask.spec.js`）。

判定ロジックの単体テストでは検出できない、OCR の行/段落分割の癖に起因する
不具合（折り返しメールの塗り漏れ等）はこの層でしか再現できない。既知の未修正
バグは fixture 側に `data-known-issue="<GitHub issue番号>"` を付けて警告ログ
のみに倒してあり、直ったら属性を外して通常の assertion に戻す。

GitHub Actions（`.github/workflows/ci.yml`）でも PR / main push ごとに同じ
スイートが走る。ただし OCR 経路の輝度アサーションはフォント環境差で揺れるため
CI では警告（`[soft-ocr]`）に落としてある（`M2G_SOFT_OCR=1`）。**OCR 経路の
正はローカル実行**なので、判定ロジックを変更したら CI 任せにせず手元でも
`bun run test:e2e` を通すこと。DOM 経路と単体テストは CI でも厳格に fail する。

### 3. 手動 E2E（目視、最終確認）

上記2層で拾いきれない見た目の違和感（マスクの余白感、UI 全体の見え方等）は
`test/fixture.html` を手動でブラウザ開いて目視する。SPEC.md の「検証手順（E2E）」
を参照。

`test/fixtures/` の各ファイルの狙いは以下（詳細は SPEC.md「追加フィクスチャ
（エッジケース）」を参照）:

- `email-wrap.html` — 狭い列幅でメールアドレスが視覚的に折り返される/短いドメイン
- `unknown-ui-labels.html` — 組み込み辞書に無い一般的な UI ラベル語彙
- `phone-postal-formats.html` — 電話・郵便番号の表記ゆれ（全角・かっこ・国番号等）
- `noise-borders.html` — 装飾的な罫線・アイコン・低コントラスト文字
- `dashboard.html` — グラフ/統計値を含むダッシュボード画面
- `admin-console.html` — DOM 経路専用。管理画面の UI 骨格（ナビ・タブ・パンくず等）の過剰マスク検出
- `opaque-regions.html` — DOM 経路専用。読めない領域（iframe/canvas/img）の丸塗りと要素種別判定

E2E は各 fixture の「過剰マスク / 塗り漏れ」件数を `[coverage]` 行として出力する。
ルール変更時はここで影響を定量的に確認できる。実ページでの探索テストは、確認画面の
デバッグ表示（reason 別件数の凡例＋「判定ログをコピー」で JSON 取得）を使う。
