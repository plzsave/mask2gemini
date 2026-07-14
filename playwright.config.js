// @ts-check
const { defineConfig } = require("@playwright/test");

// 拡張機能 + 実 OCR(tesseract.js/kuromoji) をヘッドレスで走らせるため、
// 通常の Web テストより長めのタイムアウトを取る
module.exports = defineConfig({
  testDir: "./test/e2e",
  timeout: 120_000,
  fullyParallel: false,
  reporter: "list",
});
