// node --test で実行する allowlist.js の純関数テスト（chrome.storage 非依存部分のみ）。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./allowlist.js");
const { normalizePhrase, findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;

test("normalizePhrase: 空白・句読点除去、全角半角統一、小文字化", () => {
  assert.equal(normalizePhrase("山田 太郎"), "山田太郎");
  assert.equal(normalizePhrase("ログイン中："), "ログイン中");
  assert.equal(normalizePhrase("ＡＢＣ＠ｅｘ"), "abc@ex");
});

test("findProtectedWordIndices: ユーザー登録語は1文字でも重なれば保護（fullCoverage:false）", () => {
  const units = [{ text: "山田" }, { text: "太郎" }, { text: "様" }];
  const hits = findProtectedWordIndices(units, ["山田 太郎"]);
  assert.deepEqual([...hits].sort(), [0, 1]);
});

test("findProtectedWordIndices: 組み込みラベルは全文字一致のみ保護（fullCoverage:true）", () => {
  // 「会社」がデータ中の社名（株式会社◯◯）へ部分一致して周辺断片まで
  // 解除されないことを確認する
  const units = [{ text: "株式" }, { text: "会社" }, { text: "ABC" }];
  const hits = findProtectedWordIndices(units, ["会社"], { fullCoverage: true });
  assert.deepEqual([...hits], [1]);
});

test("findProtectedWordIndices: 一致しなければ空集合", () => {
  const units = [{ text: "検索" }];
  assert.equal(findProtectedWordIndices(units, ["山田太郎"]).size, 0);
});
