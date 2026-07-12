# mask2gemini

スクリーンショットを OCR＋決定的ルール（LLM 不使用）でマスクし、Gemini にモック作成を依頼する前処理を行う Chrome 拡張（Manifest V3）のプロトタイプ。仕様は [SPEC.md](./SPEC.md) を参照。

## セットアップ

```bash
bun install
bash scripts/copy-vendor.sh   # extension/vendor/ を生成（tesseract.js 一式・言語データ）
```

1. `chrome://extensions` を開き、右上の「デベロッパーモード」を有効化
2. 「パッケージ化されていない拡張機能を読み込む」で `extension/` ディレクトリを選択

## 使い方

1. マスクしたい画面のタブで拡張アイコンをクリック
2. 確認画面が開き、OCR 完了後に自動マスクが表示される
   - 黒塗りをクリック → 解除／余白をドラッグ → 手動マスク追加
3. 「① マスク済み画像をコピー」→「③ Gemini を開く」→ 入力欄に貼り付け
4. 「② プロンプトをコピー」→ 要望部分を書き換えて送信

## チューニング

マスク判定はすべて `extension/rules.js` の定数（アローリスト辞書・文字数閾値・正規表現）で決まる。塗りすぎ・塗り漏れはここを編集する。判定は recall 優先（迷ったら塗る）に倒してある。

## 別環境への配布

```bash
bash scripts/package.sh   # dist/mask2gemini-<version>.zip を生成
```

zip を渡した先では、展開して `chrome://extensions`（デベロッパーモード）→「パッケージ化されていない拡張機能を読み込む」で `extension/` を選ぶだけ。git・bun は不要。

## E2E 検証

`test/fixture.html`（架空データの顧客管理画面）をブラウザで開いて拡張を実行し、SPEC.md の「検証手順（E2E）」に従って確認する。
