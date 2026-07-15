// ヘッドレスブラウザに拡張機能を読み込み、実際の OCR(tesseract.js/kuromoji)を
// 走らせて自動マスクの結果を検証する E2E テスト。
//
// fixture HTML の要素に data-check="mask"（塗られるべき）/ "keep"（残るべき）を
// 付けておき、review.html 側の canvas を該当座標でサンプリングして判定する。
// OCR の文字起こし結果そのもの（誤読され得る）ではなく、最終的に描画された
// マスク矩形のピクセルで判定するため、OCR のブレに強い。
"use strict";
const path = require("node:path");
const { test: base, chromium, expect } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "..", "extension");
const TEST_DIR = path.join(__dirname, "..");

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw.url().split("/")[2]);
  },
});

// fixture ページを開いてスクリーンショットを撮り、拡張の確認画面(review.html)に
// 撮影データとして渡した上で、自動マスク完了まで待つ。
// data-check 要素の座標はスクリーンショットと同じ座標系（スクロール無し前提）で返す。
async function captureAndReview(context, extensionId, fixtureRelPath) {
  const fixturePage = await context.newPage();
  await fixturePage.setViewportSize({ width: 1280, height: 900 });
  await fixturePage.goto(`file://${path.join(TEST_DIR, fixtureRelPath)}`);

  // td/div 等のブロック要素は列幅・親要素の幅に合わせて padding の外側まで
  // 広がるため、getBoundingClientRect() をそのまま使うと実際の文字グリフより
  // 広い範囲（余白）をサンプリングしてしまう。Range で文字ノードそのものの
  // 矩形を取り、OCR が実際に検出する範囲に近づける
  const rects = await fixturePage.$$eval("[data-check]", (els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return {
        check: el.dataset.check,
        knownIssue: el.dataset.knownIssue || null,
        text: el.textContent.trim() || el.className,
        x: r.x, y: r.y, w: r.width, h: r.height,
      };
    }));

  const screenshot = await fixturePage.screenshot();
  const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;

  // マスク前の基準輝度を、実際に OCR に渡すのと同じ PNG バイト列から測定する
  // （DOM のスタイルから輝度を推定すると、紺色背景ボタン等で誤判定するため）。
  const origBrightness = await fixturePage.evaluate(sampleImageRects, { dataUrl, rects });
  await fixturePage.close();

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  // Worker.evaluate() は Playwright のテスト API（対象ワーカー内でコードを実行し
  // 結果をシリアライズして返す）。JS の eval() とは無関係で、テスト対象の
  // 拡張機能サービスワーカーへ既知の固定コードを注入するだけの用途
  await sw.evaluate(async (url) => {
    await chrome.storage.session.set({ capture: { dataUrl: url } });
  }, dataUrl);

  const reviewPage = await context.newPage();
  await reviewPage.goto(`chrome-extension://${extensionId}/review.html`);
  await reviewPage.locator("#status").filter({ hasText: "自動マスク" }).waitFor({ timeout: 100_000 });

  const maskedBrightness = await reviewPage.evaluate(sampleCanvasRects, { rects });

  return {
    checks: rects.map((r, i) => ({ ...r, orig: origBrightness[i], masked: maskedBrightness[i] })),
  };
}

// fixturePage.evaluate() 内で実行する関数。dataUrl の画像を off-screen canvas に
// 描き、スクリーンショットそのものの上で rects を計測する（マスク前の基準値）
async function sampleImageRects({ dataUrl, rects }) {
  /* eslint-disable no-undef */
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const step = 4;
  return rects.map(({ x, y, w, h }) => {
    let total = 0, count = 0;
    for (let dx = 2; dx < Math.max(w - 2, 3); dx += step) {
      for (let dy = 2; dy < Math.max(h - 2, 3); dy += step) {
        const d = ctx.getImageData(Math.round(x + dx), Math.round(y + dy), 1, 1).data;
        total += (d[0] + d[1] + d[2]) / 3;
        count++;
      }
    }
    return count ? total / count : null;
  });
  /* eslint-enable no-undef */
}

// reviewPage.evaluate() 内で実行する関数。review.js が描画済みの #canvas 上で計測する
async function sampleCanvasRects({ rects }) {
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const step = 4;
  return rects.map(({ x, y, w, h }) => {
    let total = 0, count = 0;
    for (let dx = 2; dx < Math.max(w - 2, 3); dx += step) {
      for (let dy = 2; dy < Math.max(h - 2, 3); dy += step) {
        const d = ctx.getImageData(Math.round(x + dx), Math.round(y + dy), 1, 1).data;
        total += (d[0] + d[1] + d[2]) / 3;
        count++;
      }
    }
    return count ? total / count : null;
  });
}

// マスク矩形は #000 の完全な黒塗りなので、塗られていれば背景色に関わらず
// 輝度は 0 近辺まで落ちる。残すべき要素は「元の輝度からほぼ変化しない」ことを
// 見る（紺色背景ボタン等、要素ごとに地の色が違っても閾値が破綻しないようにするため）。
//
// data-known-issue="<GitHub issue番号>" が付いた要素は、既知の未修正バグとして
// 追跡中のもの。ここで hard failure にすると常時 red なテストスイートになり
// 新規デグレのシグナルが埋もれるため、警告ログのみ出して assertion はスキップする。
// 挙動が直ったら data-known-issue を外し、通常の assertion に戻すこと。
function assertChecks(checks) {
  for (const c of checks) {
    if (c.knownIssue) {
      const drop = c.orig - c.masked;
      console.warn(
        `[known-issue #${c.knownIssue}] 「${c.text}」: 元輝度 ${c.orig} → マスク後 ${c.masked}`
        + `（${c.check === "mask" ? "本来は黒塗りされるべき" : "本来は残るべき"}）`);
      continue;
    }
    if (c.check === "mask") {
      expect(c.masked, `「${c.text}」は黒塗りされているべき（元輝度 ${c.orig} → マスク後 ${c.masked}）`)
        .toBeLessThan(40);
    } else {
      expect(Math.abs(c.masked - c.orig), `「${c.text}」は残っているべき（元輝度 ${c.orig} → マスク後 ${c.masked}）`)
        .toBeLessThan(20);
    }
  }
}

test.describe("mask2gemini E2E（実 OCR）", () => {
  test("fixture.html: 顧客管理画面の基本ケース", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixture.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks);
  });

  test("fixtures/email-wrap.html: 折り返しメールも全断片が塗られる", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/email-wrap.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks);
  });

  test("fixtures/unknown-ui-labels.html: 辞書内の一般語は残る", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/unknown-ui-labels.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks);
  });

  test("fixtures/noise-borders.html: 装飾要素・罫線は誤マスクされない", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/noise-borders.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks);
  });

  // Issue #4: デバッグオーバーレイは #debug-overlay という別 canvas に描画され、
  // copy-image がコピーする #canvas には一切触れない設計になっている。
  // その前提が壊れていないことを、デバッグ表示ON/OFFで #canvas の
  // toDataURL() が完全に一致することで直接検証する。
  test("review.html: デバッグ表示のON/OFFで#canvas（コピー対象）のピクセルは変化しない", async ({ context, extensionId }) => {
    const fixturePage = await context.newPage();
    await fixturePage.setViewportSize({ width: 1280, height: 900 });
    await fixturePage.goto(`file://${path.join(TEST_DIR, "fixture.html")}`);
    const screenshot = await fixturePage.screenshot();
    const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
    await fixturePage.close();

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await sw.evaluate(async (url) => {
      await chrome.storage.session.set({ capture: { dataUrl: url } });
    }, dataUrl);

    const reviewPage = await context.newPage();
    await reviewPage.goto(`chrome-extension://${extensionId}/review.html`);
    await reviewPage.locator("#status").filter({ hasText: "自動マスク" }).waitFor({ timeout: 100_000 });

    const canvasDataUrl = () =>
      reviewPage.evaluate(() => document.getElementById("canvas").toDataURL());

    const beforeDebug = await canvasDataUrl();

    await reviewPage.locator("#debug-toggle").check();
    await expect(reviewPage.locator("#debug-overlay")).toHaveClass(/visible/);
    expect(await canvasDataUrl()).toBe(beforeDebug);

    await reviewPage.locator("#debug-toggle").uncheck();
    await expect(reviewPage.locator("#debug-overlay")).not.toHaveClass(/visible/);
    expect(await canvasDataUrl()).toBe(beforeDebug);
  });
});
