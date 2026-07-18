// 利用者ガイド（GUIDE.html）用のスクリーンショットを生成する（Issue #32）。
// E2E（test/e2e/mask.spec.js）と同じ流儀で拡張を Chromium に読み込み、
// fixture.html を DOM 経路で処理した確認画面と、語句を登録済みの設定画面を撮る。
// UI 変更でガイドの見た目が古くなったら `node scripts/capture-guide-shots.mjs` で再生成する
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = path.join(root, "extension");
const outDir = path.join(root, "guide");
fs.mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
  ],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker");
const extensionId = sw.url().split("/")[2];

// --- 確認画面: fixture.html を DOM 経路で処理した状態 ---
const fixturePage = await context.newPage();
await fixturePage.setViewportSize({ width: 1280, height: 900 });
await fixturePage.goto(`file://${path.join(root, "test", "fixture.html")}`);
const domExtractorSource = fs.readFileSync(path.join(EXTENSION_PATH, "dom-extractor.js"), "utf8");
const domExtract = await fixturePage.evaluate(domExtractorSource);
const screenshot = await fixturePage.screenshot();
await fixturePage.close();

await sw.evaluate(async ({ dataUrl, domExtract }) => {
  await chrome.storage.session.remove(["capture", "captureError", "domExtract", "domExtractError"]);
  await chrome.storage.session.set({ capture: { dataUrl }, domExtract });
}, { dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`, domExtract });

const reviewPage = await context.newPage();
await reviewPage.setViewportSize({ width: 1280, height: 1000 });
await reviewPage.goto(`chrome-extension://${extensionId}/review.html`);
await reviewPage.locator("#status").filter({ hasText: "自動マスク" }).waitFor({ timeout: 100_000 });
await reviewPage.screenshot({ path: path.join(outDir, "review.png") });
console.log("guide/review.png を生成");
await reviewPage.close();

// --- 設定画面: ホワイトリストに語句を登録済みの状態 ---
await sw.evaluate(async () => {
  await chrome.storage.local.set({ userAllowlist: ["株式会社ABC", "山田 太郎"] });
});
const optionsPage = await context.newPage();
await optionsPage.setViewportSize({ width: 1000, height: 700 });
await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
await optionsPage.waitForTimeout(500);
await optionsPage.screenshot({ path: path.join(outDir, "options.png") });
console.log("guide/options.png を生成");

await context.close();
