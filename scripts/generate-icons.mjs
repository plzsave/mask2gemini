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

// モチーフ: 斜め上から見た 3 層スタック。上から
//   1層目 = 撮影（レンズリング＋照準ティック）
//   2層目 = マスク済みページ（ラベル行が残り、データ行が黒塗り）
//   3層目 = クリップボード（コピーの行き先。確定事項4のとおり受け渡しはここまで）
// 各層のグリフも板と同じ iso 変形に乗せ、パースを統一する

// 板 1 枚 = 上面（rotate45 + scale(1,0.55) した角丸矩形）＋厚み（下へずらした暗色）
const plate = (cy, w, topFill, sideFill, content = "") => `
  <g transform="translate(64,${cy + 8}) scale(1,0.55) rotate(45)">
    <rect x="${-w / 2}" y="${-w / 2}" width="${w}" height="${w}" rx="14" fill="${sideFill}"/>
  </g>
  <g transform="translate(64,${cy}) scale(1,0.55) rotate(45)">
    <rect x="${-w / 2}" y="${-w / 2}" width="${w}" height="${w}" rx="14" fill="${topFill}"/>
    ${content}
  </g>`;

// 1層目（撮影）: レンズリング＋照準ティック（クロスヘア）
const captureContent = `
  <circle r="11" fill="none" stroke="#ffffff" stroke-width="6"/>
  <g stroke="#ffffff" stroke-width="5" stroke-linecap="round">
    <line x1="0" y1="-24" x2="0" y2="-18"/>
    <line x1="0" y1="18" x2="0" y2="24"/>
    <line x1="-24" y1="0" x2="-18" y2="0"/>
    <line x1="18" y1="0" x2="24" y2="0"/>
  </g>`;

// 2層目（マスク済みページ）: ラベル行（灰）＋黒塗りバー。上の板に隠れない
// 下半分の見える帯に寄せる
const maskContent = `
  <rect x="-20" y="-14" width="24" height="7" rx="3.5" fill="#b0bec5"/>
  <rect x="-20" y="0" width="40" height="11" rx="3" fill="#111111"/>
  <rect x="-20" y="18" width="28" height="11" rx="3" fill="#111111"/>`;

// 3層目（クリップボード）: 白い紙面＋留め金＋罫線。板と同じ iso 変形のまま
// （正面向きに起こすと「シールを貼った」ような浮きが出るため。ユーザー確定）
const clipboardContent = `
  <g transform="translate(4,4)">
    <rect x="-13" y="-14" width="26" height="30" rx="4" fill="#ffffff"/>
    <rect x="-5" y="-18" width="10" height="7" rx="3" fill="#37474f"/>
    <rect x="-8" y="-5" width="16" height="4" rx="2" fill="#b0bec5"/>
    <rect x="-8" y="4" width="12" height="4" rx="2" fill="#b0bec5"/>
  </g>`;

const DETAILED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#283593"/>
  ${plate(100, 52, "#90a4ae", "#546e7a", clipboardContent)}
  ${plate(64, 52, "#eceff1", "#90a4ae", maskContent)}
  ${plate(28, 52, "#7986cb", "#3f51b5", captureContent)}
</svg>`;

// 32px 用: 各層の中身を 1 要素まで減らす
const SIMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#283593"/>
  ${plate(98, 58, "#90a4ae", "#546e7a")}
  ${plate(64, 58, "#ffffff", "#90a4ae", `<rect x="-20" y="2" width="40" height="14" rx="4" fill="#111111"/>`)}
  ${plate(30, 58, "#7986cb", "#3f51b5", `<circle r="10" fill="none" stroke="#ffffff" stroke-width="7"/>`)}
</svg>`;

// 16px 用: タイル無しで板 3 枚だけ。中段の黒バーが「マスク」の記号として残る
const TINY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  ${plate(102, 62, "#78909c", "#455a64")}
  ${plate(64, 62, "#ffffff", "#90a4ae", `<rect x="-22" y="0" width="44" height="18" rx="5" fill="#111111"/>`)}
  ${plate(26, 62, "#5c6bc0", "#303f9f")}
</svg>`;

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage();
for (const [size, svg] of [[16, TINY], [32, SIMPLE], [48, DETAILED], [128, DETAILED]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block}</style>`
    + svg.replace("<svg ", `<svg width="${size}" height="${size}" `));
  const buf = await page.screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log(`extension/icons/icon${size}.png を生成`);
}
await browser.close();
