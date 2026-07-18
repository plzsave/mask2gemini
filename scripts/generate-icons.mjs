// 拡張アイコン（extension/icons/icon{16,32,48,128}.png）を SVG から生成する（Issue #31）。
// デザイン変更時は下の SVG を編集して `node scripts/generate-icons.mjs` で再生成する。
// ラスタライズには devDependencies の Playwright（E2E と同じ Chromium）を使い、
// 画像ライブラリの依存を増やさない
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });

// モチーフ: スクリーンショット（白い紙面）に黒塗りバーが載っている状態
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#3949ab"/>
  <rect x="24" y="18" width="80" height="92" rx="8" fill="#ffffff"/>
  <rect x="34" y="34" width="60" height="14" rx="3" fill="#111111"/>
  <rect x="34" y="58" width="42" height="14" rx="3" fill="#111111"/>
  <rect x="34" y="82" width="26" height="14" rx="3" fill="#111111"/>
</svg>`;

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg(size)}`);
  const buf = await page.screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log(`extension/icons/icon${size}.png を生成`);
}
await browser.close();
