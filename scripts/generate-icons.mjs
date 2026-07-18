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

// モチーフ: ファインダー枠（撮影）の中に、クリップボード（貼り付け先）へ挟まれた
// スクリーンショット。中身はラベル行（灰）が残り、データ行（黒バー）がマスク済み
// — 「撮影 → マスク → クリップボードへ」の一連の流れを 1 枚で表す
const DETAILED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#3949ab"/>
  <!-- クリップボードの板と留め金 -->
  <rect x="30" y="24" width="68" height="90" rx="8" fill="#eceff1"/>
  <rect x="53" y="15" width="22" height="16" rx="6" fill="#78909c"/>
  <rect x="60" y="19" width="8" height="5" rx="2.5" fill="#eceff1"/>
  <!-- 挟まれたスクリーンショット（ミニブラウザウィンドウ） -->
  <rect x="37" y="36" width="54" height="70" rx="4" fill="#ffffff" stroke="#cfd8dc" stroke-width="2"/>
  <path d="M38 40 a3 3 0 0 1 3-3 h46 a3 3 0 0 1 3 3 v7 h-52 z" fill="#e3e7ea"/>
  <circle cx="44" cy="42" r="2.2" fill="#ef5350"/>
  <circle cx="51" cy="42" r="2.2" fill="#ffb300"/>
  <circle cx="58" cy="42" r="2.2" fill="#66bb6a"/>
  <!-- 残るラベル行（灰）とマスク済みデータ行（黒） -->
  <rect x="43" y="54" width="26" height="5" rx="2.5" fill="#b0bec5"/>
  <rect x="43" y="63" width="42" height="8" rx="2" fill="#111111"/>
  <rect x="43" y="77" width="20" height="5" rx="2.5" fill="#b0bec5"/>
  <rect x="43" y="86" width="34" height="8" rx="2" fill="#111111"/>
  <rect x="43" y="98" width="30" height="5" rx="2.5" fill="#b0bec5"/>
  <!-- ファインダー枠（撮影） -->
  <g stroke="#ffffff" stroke-width="6" fill="none" stroke-linecap="round">
    <path d="M12 30 v-10 a8 8 0 0 1 8-8 h10"/>
    <path d="M98 12 h10 a8 8 0 0 1 8 8 v10"/>
    <path d="M116 98 v10 a8 8 0 0 1 -8 8 h-10"/>
    <path d="M30 116 h-10 a8 8 0 0 1 -8 -8 v-10"/>
  </g>
</svg>`;

// 16/32px 用の簡略版。縮小で潰れる装飾（ウィンドウバー・留め金の穴・細部）を
// 落とし、「クリップボード＋黒塗りバー＋ファインダー枠」だけを太く残す
const SIMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#3949ab"/>
  <rect x="30" y="22" width="68" height="92" rx="10" fill="#ffffff"/>
  <rect x="50" y="10" width="28" height="20" rx="7" fill="#78909c"/>
  <rect x="40" y="44" width="34" height="10" rx="4" fill="#b0bec5"/>
  <rect x="40" y="64" width="48" height="16" rx="4" fill="#111111"/>
  <rect x="40" y="90" width="36" height="16" rx="4" fill="#111111"/>
  <g stroke="#ffffff" stroke-width="10" fill="none" stroke-linecap="round">
    <path d="M10 32 v-12 a10 10 0 0 1 10-10 h12"/>
    <path d="M96 10 h12 a10 10 0 0 1 10 10 v12"/>
    <path d="M118 96 v12 a10 10 0 0 1 -10 10 h-12"/>
    <path d="M32 118 h-12 a10 10 0 0 1 -10 -10 v-12"/>
  </g>
</svg>`;

// 16px ではファインダー枠が縁のノイズにしかならないため外し、
// クリップボード＋黒塗りバーだけを残す
const TINY = SIMPLE.replace(/<g stroke[\s\S]*?<\/g>\n/, "");

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  const svg = size === 16 ? TINY : size === 32 ? SIMPLE : DETAILED;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block}</style>`
    + svg.replace("<svg ", `<svg width="${size}" height="${size}" `));
  const buf = await page.screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log(`extension/icons/icon${size}.png を生成`);
}
await browser.close();
