// ヘッドレスブラウザに拡張機能を読み込み、実際の OCR(tesseract.js/kuromoji)を
// 走らせて自動マスクの結果を検証する E2E テスト。
//
// fixture HTML の要素に data-check="mask"（塗られるべき）/ "keep"（残るべき）を
// 付けておき、review.html 側の canvas を該当座標でサンプリングして判定する。
// OCR の文字起こし結果そのもの（誤読され得る）ではなく、最終的に描画された
// マスク矩形のピクセルで判定するため、OCR のブレに強い。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { test: base, chromium, expect } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "..", "extension");
const TEST_DIR = path.join(__dirname, "..");

// DOM 経路テスト用: dom-extractor.js を fixture ページ内で評価して抽出結果を得る。
// 実運用では background.js が chrome.scripting.executeScript で注入するが、
// Playwright から拡張のアイコンクリックは起こせないため、既存テストが capture を
// storage.session に直接注入しているのと同じ流儀で domExtract も注入する
const DOM_EXTRACTOR_SOURCE = fs.readFileSync(
  path.join(EXTENSION_PATH, "dom-extractor.js"), "utf8");

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
// domPath: true なら dom-extractor.js の抽出結果も注入し、DOM 経路で処理させる
async function captureAndReview(context, extensionId, fixtureRelPath, { domPath = false } = {}) {
  const fixturePage = await context.newPage();
  await fixturePage.setViewportSize({ width: 1280, height: 900 });
  await fixturePage.goto(`file://${path.join(TEST_DIR, fixtureRelPath)}`);

  // td/div 等のブロック要素は列幅・親要素の幅に合わせて padding の外側まで
  // 広がるため、getBoundingClientRect() をそのまま使うと実際の文字グリフより
  // 広い範囲（余白）をサンプリングしてしまう。Range で文字ノードそのものの
  // 矩形を取り、OCR が実際に検出する範囲に近づける。テキストを持たない要素
  // （img/canvas/iframe 等、丸塗り対象）は要素矩形をそのまま使う
  const rects = await fixturePage.$$eval("[data-check]", (els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      let r = range.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) r = el.getBoundingClientRect();
      return {
        check: el.dataset.check,
        knownIssue: el.dataset.knownIssue || null,
        text: el.textContent.trim() || el.className || el.tagName.toLowerCase(),
        x: r.x, y: r.y, w: r.width, h: r.height,
      };
    }));

  // page.evaluate(文字列) はテスト対象リポジトリ内の固定ソース
  // （extension/dom-extractor.js）をそのまま実行するだけで、外部入力・動的生成
  // コードは評価しない（sw.evaluate と同じ整理。eval 相当だが対象は自前コードのみ）
  const domExtract = domPath ? await fixturePage.evaluate(DOM_EXTRACTOR_SOURCE) : null;

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
  await sw.evaluate(async ({ url, domExtract }) => {
    await chrome.storage.session.remove(["capture", "captureError", "domExtract", "domExtractError"]);
    await chrome.storage.session.set({ capture: { dataUrl: url } });
    if (domExtract) await chrome.storage.session.set({ domExtract });
  }, { url: dataUrl, domExtract });

  const reviewPage = await context.newPage();
  await reviewPage.goto(`chrome-extension://${extensionId}/review.html`);
  await reviewPage.locator("#status").filter({ hasText: "自動マスク" }).waitFor({ timeout: 100_000 });

  const maskedBrightness = await reviewPage.evaluate(sampleCanvasRects, { rects });
  const statusText = await reviewPage.locator("#status").textContent();

  return {
    checks: rects.map((r, i) => ({ ...r, orig: origBrightness[i], masked: maskedBrightness[i] })),
    statusText,
    domExtract,
    reviewPage,
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
// マスク判定の閾値（assertChecks と集計で共有）。黒塗りは輝度 0 近辺まで落ちる
const MASKED_MAX_BRIGHTNESS = 40;
const KEEP_MAX_BRIGHTNESS_DELTA = 20;

// 過剰マスク/塗り漏れの定量サマリ。pass/fail の binary だけでなく、ルール変更の
// 影響（keep 違反 = 過剰マスク、mask 違反 = 塗り漏れ）を件数で追えるようにする。
// known-issue の要素も件数には含める（追跡中の違反も母数として見えるべきため）
function reportViolations(label, checks) {
  const keep = checks.filter((c) => c.check === "keep");
  const mask = checks.filter((c) => c.check === "mask");
  const keepViolations = keep.filter((c) => Math.abs(c.masked - c.orig) >= KEEP_MAX_BRIGHTNESS_DELTA);
  const maskViolations = mask.filter((c) => c.masked >= MASKED_MAX_BRIGHTNESS);
  console.log(
    `[coverage] ${label}: 過剰マスク ${keepViolations.length}/${keep.length}`
    + `、塗り漏れ ${maskViolations.length}/${mask.length}`
    + (keepViolations.length ? ` | 過剰: ${keepViolations.map((c) => `「${c.text}」`).join(" ")}` : "")
    + (maskViolations.length ? ` | 漏れ: ${maskViolations.map((c) => `「${c.text}」`).join(" ")}` : ""));
}

// OCR 経路の輝度アサーションはフォント環境（ラスタライズ・CJK 字形バリアント）に
// 依存して揺れる。CI 等のローカルと異なる描画環境では M2G_SOFT_OCR=1 を立てると
// OCR 経路の違反を known-issue と同様の警告ログに落とす（fail させない）。
// DOM 経路のテストはフォント差の影響を受けないため常に厳格。
// OCR 経路の正はローカル実行（SPEC.md「DO: 判定ロジック変更時は test:e2e」）。
const SOFT_OCR = process.env.M2G_SOFT_OCR === "1";

function assertChecks(checks, label = "", { softable = false } = {}) {
  if (label) reportViolations(label, checks);
  const soft = softable && SOFT_OCR;
  for (const c of checks) {
    if (soft) {
      const violated = c.check === "mask"
        ? c.masked >= MASKED_MAX_BRIGHTNESS
        : Math.abs(c.masked - c.orig) >= KEEP_MAX_BRIGHTNESS_DELTA;
      if (violated) {
        console.warn(`[soft-ocr] 「${c.text}」: 元輝度 ${c.orig} → マスク後 ${c.masked}`
          + `（${c.check === "mask" ? "本来は黒塗りされるべき" : "本来は残るべき"}。環境差として許容）`);
        continue;
      }
    }
    if (c.knownIssue) {
      const drop = c.orig - c.masked;
      console.warn(
        `[known-issue #${c.knownIssue}] 「${c.text}」: 元輝度 ${c.orig} → マスク後 ${c.masked}`
        + `（${c.check === "mask" ? "本来は黒塗りされるべき" : "本来は残るべき"}）`);
      continue;
    }
    if (c.check === "mask") {
      expect(c.masked, `「${c.text}」は黒塗りされているべき（元輝度 ${c.orig} → マスク後 ${c.masked}）`)
        .toBeLessThan(MASKED_MAX_BRIGHTNESS);
    } else {
      expect(Math.abs(c.masked - c.orig), `「${c.text}」は残っているべき（元輝度 ${c.orig} → マスク後 ${c.masked}）`)
        .toBeLessThan(KEEP_MAX_BRIGHTNESS_DELTA);
    }
  }
}

test.describe("mask2gemini E2E（実 OCR）", () => {
  test("fixture.html: 顧客管理画面の基本ケース", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixture.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixture.html (OCR)", { softable: true });
  });

  test("fixtures/email-wrap.html: 折り返しメールも全断片が塗られる", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/email-wrap.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/email-wrap.html (OCR)", { softable: true });
  });

  test("fixtures/unknown-ui-labels.html: 辞書内の一般語は残る", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/unknown-ui-labels.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/unknown-ui-labels.html (OCR)", { softable: true });
  });

  test("fixtures/phone-postal-formats.html: 電話・郵便番号は区切り文字ごと塗られる", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/phone-postal-formats.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/phone-postal-formats.html (OCR)", { softable: true });
  });

  test("fixtures/noise-borders.html: 装飾要素・罫線は誤マスクされない", async ({ context, extensionId }) => {
    const { checks } = await captureAndReview(context, extensionId, "fixtures/noise-borders.html");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/noise-borders.html (OCR)", { softable: true });
  });

  // ---- DOM 経路（Issue #13）。OCR を使わないため実行は数秒で終わる ----

  test("fixture.html（DOM経路）: OCR と同じ期待結果を DOM 抽出で満たす", async ({ context, extensionId }) => {
    const { checks, statusText } = await captureAndReview(
      context, extensionId, "fixture.html", { domPath: true });
    expect(statusText).toContain("ページ構造を解析");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixture.html (DOM)");
  });

  test("fixtures/admin-console.html（DOM経路）: 管理画面のUI骨格が過剰マスクされない", async ({ context, extensionId }) => {
    // 想定ユース（社内 Web アプリの管理画面）の代表形。サイドバーナビ・タブ・
    // パンくず・フォームラベル等の「残るべき UI 骨格」が塗られたら fail する、
    // 過剰マスク検出に特化したフィクスチャ
    const { checks, statusText, domExtract } = await captureAndReview(
      context, extensionId, "fixtures/admin-console.html", { domPath: true });
    expect(statusText).toContain("ページ構造を解析");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/admin-console.html (DOM)");
    // password の生の値は抽出結果（storage.session に入るデータ）に載らないこと。
    // 画面に見えない値の収集は目的外（sensitive-data-exposure 対策）
    expect(JSON.stringify(domExtract)).not.toContain("KAgi-9973-himitsu");
  });

  test("fixtures/dashboard.html（DOM経路）: 数字+単位の隣接指標が過剰マスクされない（Issue #7）", async ({ context, extensionId }) => {
    // DOM 経路のみで検証する。fixture の td の mask 期待は要素種別判定
    // （確定事項11: td=データ位置）前提で、OCR 経路には構造情報が無く
    // 「正常」「警告」等の一般語 td は原理的に残るため、OCR 経路の E2E 対象に
    // すると常時 red になる。単位隣接判定そのものは両経路共通の
    // rules.js/mask-decider.js にあり、ユニットテストが両経路相当を覆っている
    const { checks, statusText, reviewPage } = await captureAndReview(
      context, extensionId, "fixtures/dashboard.html", { domPath: true });
    expect(statusText).toContain("ページ構造を解析");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/dashboard.html (DOM)");
    // ワイヤーフレーム出力（Issue #20）は既定オフ: ④ボタンは表示されない
    await expect(reviewPage.locator("#save-wireframe")).toBeHidden();
  });

  test("ワイヤーフレーム出力（Issue #20）: 設定オンで .excalidraw が保存でき、マスク文字列を含まない", async ({ context, extensionId }) => {
    // 設定トグル相当のフラグを立ててから確認画面を開く（options.js と同じキー）
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await sw.evaluate(() => chrome.storage.local.set({ wireframeExportEnabled: true }));

    const { domExtract, reviewPage } = await captureAndReview(
      context, extensionId, "fixtures/dashboard.html", { domPath: true });

    // dom-extractor が装飾ボックス（カード・棒グラフのバー・罫線）を収集していること
    expect(domExtract.decor.length).toBeGreaterThan(0);

    const btn = reviewPage.locator("#save-wireframe");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();

    const [download] = await Promise.all([
      reviewPage.waitForEvent("download"),
      btn.click(),
    ]);
    expect(download.suggestedFilename()).toBe("mask2gemini-wireframe.excalidraw");
    const file = JSON.parse(fs.readFileSync(await download.path(), "utf8"));

    // .excalidraw の骨格
    expect(file.type).toBe("excalidraw");
    expect(file.version).toBe(2);
    expect(file.elements.length).toBeGreaterThan(0);

    // 残るべきラベルはテキスト要素として実文字列で入る（トークンはマージ済み）
    const texts = file.elements.filter((e) => e.type === "text").map((e) => e.text);
    expect(texts).toContain("運用ダッシュボード");
    expect(texts.some((t) => t.includes("稼働率"))).toBe(true);
    // v0.7.0 の単位付き指標も残る
    expect(texts.some((t) => t.includes("99.95%"))).toBe(true);

    // マスクした文字列はファイルのどこにも含まれない（確定事項12）
    const json = JSON.stringify(file);
    for (const pii of ["岡田", "藤田", "健太", "128,450", "error_code", "gateway"]) {
      expect(json).not.toContain(pii);
    }
    // マスク由来のハッチ矩形と、装飾由来の実色矩形（ヘッダー紺 #2b4a6f）が両方ある
    const rects = file.elements.filter((e) => e.type === "rectangle");
    expect(rects.some((r) => r.fillStyle === "hachure")).toBe(true);
    expect(rects.some((r) => r.backgroundColor === "rgb(43, 74, 111)")).toBe(true);
    // customData: 抽出由来の全要素に意味のメタデータが刻まれている
    // （customData の無い要素 = 後から人間が追加したもの、という読み分けの前提）
    expect(file.elements.every((e) => e.customData?.m2g?.role)).toBe(true);
    // マスク矩形は「何の枠だったか」の判定種別を持つ（文字列そのものは持たない）
    const maskedRoles = file.elements.filter((e) => e.customData.m2g.role === "masked");
    expect(maskedRoles.length).toBeGreaterThan(0);
    expect(maskedRoles.every((e) => typeof e.customData.m2g.reason === "string")).toBe(true);
  });

  test("ワイヤーフレーム出力（Issue #23）: アイコンがマスク済み画像の切り抜きとして埋め込まれる", async ({ context, extensionId }) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await sw.evaluate(() => chrome.storage.local.set({ wireframeExportEnabled: true }));

    const { checks, domExtract, reviewPage } = await captureAndReview(
      context, extensionId, "fixtures/icons.html", { domPath: true });
    assertChecks(checks, "fixtures/icons.html (DOM)");

    // dom-extractor がアイコン領域を収集していること
    // （16px svg・16px img・bg-image 20px・PUA グリフ = 4 種）
    expect(domExtract.icons.length).toBe(4);
    // PUA グリフはテキスト行から除外される（ハッチ矩形ではなくアイコンになる）
    expect(JSON.stringify(domExtract.lines)).not.toContain("\uE0A2");
    // 48px の img はアイコンではなく従来どおり丸塗り対象
    expect(domExtract.opaque.some((o) => o.kind === "img" && o.w >= 24)).toBe(true);

    const [download] = await Promise.all([
      reviewPage.waitForEvent("download"),
      reviewPage.locator("#save-wireframe").click(),
    ]);
    const file = JSON.parse(fs.readFileSync(await download.path(), "utf8"));

    // アイコンは image 要素 + files（マスク済みキャンバスからの切り抜き）
    const images = file.elements.filter((e) => e.type === "image");
    expect(images.length).toBe(domExtract.icons.length);
    for (const img of images) {
      const entry = file.files[img.fileId];
      expect(entry).toBeTruthy();
      expect(entry.dataURL.startsWith("data:image/png;base64,")).toBe(true);
      expect(entry.dataURL.length).toBeGreaterThan(100); // 空クロップでないこと
      expect(entry.created).toBe(0); // 決定性（確定事項12）
      expect(img.width).toBeLessThanOrEqual(64); // 丸塗り対象の大きい img は埋め込まれない
    }
    // 大きい img は cross-hatch 矩形のまま
    expect(file.elements.some((e) => e.fillStyle === "cross-hatch")).toBe(true);
    // マスク文字列・PUA 文字はファイルに含まれない
    const json = JSON.stringify(file);
    expect(json).not.toContain("山田太郎");
    expect(json).not.toContain("\uE0A2");
  });

  test("fixtures/opaque-regions.html（DOM経路）: 読めない領域の丸塗りと要素種別判定", async ({ context, extensionId }) => {
    const { checks, statusText } = await captureAndReview(
      context, extensionId, "fixtures/opaque-regions.html", { domPath: true });
    expect(statusText).toContain("ページ構造を解析");
    expect(checks.length).toBeGreaterThan(0);
    assertChecks(checks, "fixtures/opaque-regions.html (DOM)");
  });

  test("OCRフォールバック: domExtract が無ければ従来経路のステータスになる", async ({ context, extensionId }) => {
    // 既存の OCR テスト群がフォールバック経路の本体を回帰確認している。
    // ここでは経路表示（確定事項9: どちらを使ったかをステータスに出す）だけを見る
    const { statusText } = await captureAndReview(context, extensionId, "fixture.html");
    expect(statusText).toContain("画像から文字認識");
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
