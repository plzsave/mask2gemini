// node --test で実行する mask-decider.js の統合テスト（review.js の判定ループを
// DOM/chrome/OCR 抜きで検証する）。rules.js・allowlist.js の実装をそのまま使う。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./rules.js");
require("./allowlist.js");
require("./mask-decider.js");

const { judge, judgeToken, findLinePatternMaskIndices, UI_LABEL_ALLOWLIST } =
  globalThis.Mask2GeminiRules;
const { findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;
const { lineToUnits, decideParagraphMasks } = globalThis.Mask2GeminiMaskDecider;

const baseDeps = (overrides = {}) => ({
  judge, judgeToken, findLinePatternMaskIndices, findProtectedWordIndices,
  userTerms: [],
  labelTerms: [...UI_LABEL_ALLOWLIST],
  noiseConfidence: 35,
  ocrScale: 2,
  maskPadding: 3,
  ...overrides,
});

// bbox は OCR_SCALE=2 前提の座標系で組み立てる（テスト用の簡易値）
const unit = (text, { confidence = 90, x0 = 0 } = {}) => ({
  text, confidence, bbox: { x0, y0: 0, x1: x0 + 10, y1: 10 }, token: null,
});

test("lineToUnits: tokenizer が無ければ OCR word 単位のまま返す", () => {
  const line = { words: [{ text: "保存", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90 }] };
  const units = lineToUnits(line, null);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "保存");
  assert.equal(units[0].token, null);
});

test("decideParagraphMasks: 断片化したメールは行(段落)結合で全断片が塗られる", () => {
  const units = [unit("foo@", { x0: 0 }), unit("bar", { x0: 10 }), unit(".com", { x0: 20 })];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 3);
  assert.ok(masks.every((m) => m.reason === "email"));
  assert.ok(decisions.every((d) => d.includes("塗:email")));
});

test("decideParagraphMasks: 段落をまたいでOCR行が分かれても連結して検出する", () => {
  // Tesseract が視覚的な折り返しを2行として認識したケースを想定し、
  // 呼び出し側（review.js）が段落全体を1つの units 配列に連結して渡す前提を検証する
  const units = [
    unit("watanabe"), unit("."), unit("contact"), unit("."),
    unit("address"), unit("@"), unit("subdomain"), unit("."), unit("example"), unit("."), unit("org"),
  ];
  const { masks } = decideParagraphMasks(units, baseDeps());
  const addressMask = masks.find((m) => m.text === "address");
  assert.ok(addressMask, "「address」断片が塗られていること");
  assert.equal(addressMask.reason, "email");
});

test("decideParagraphMasks: 組み込みUIラベルは塗らない", () => {
  const units = [unit("検索"), unit("保存")];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
});

test("decideParagraphMasks: ユーザー登録語は自動ルールより優先して残る", () => {
  const units = [unit("090"), unit("-"), unit("1234")]; // digit なので本来は塗られる
  const { masks } = decideParagraphMasks(units, baseDeps({ userTerms: ["090-1234"] }));
  assert.equal(masks.length, 0);
});

test("decideParagraphMasks: 低信頼度の非データ語（罫線誤認識）は塗らない", () => {
  const units = [unit("巡", { confidence: 2 })]; // confidence ≒ 0 のノイズ想定
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
  assert.ok(decisions[0].startsWith("巡=残:noise"));
});

test("decideParagraphMasks: 低信頼度でも @ を含む語は塗る（安全側）", () => {
  const units = [unit("a@b.co", { confidence: 2 })];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
});
