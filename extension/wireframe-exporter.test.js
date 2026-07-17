// node --test で実行する wireframe-exporter.js の単体テスト（Issue #20・確定事項12）
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./wireframe-exporter.js");

const { buildWireframe, mergeTextRuns } = globalThis.Mask2GeminiWireframeExporter;

const keptUnit = (text, x, { y = 0, w = 30, h = 15, blockId = 0 } = {}) =>
  ({ text, x, y, w, h, reason: "allowlist", blockId });

test("buildWireframe: .excalidraw のファイル骨格（type/version/elements）を持つ", () => {
  const file = buildWireframe({ masks: [], kept: [] });
  assert.equal(file.type, "excalidraw");
  assert.equal(file.version, 2);
  assert.equal(file.source, "mask2gemini");
  assert.ok(Array.isArray(file.elements));
  assert.ok(file.appState);
});

test("buildWireframe: 残存テキストは text 要素、マスクは rectangle になる", () => {
  const file = buildWireframe({
    masks: [{ x: 100, y: 0, w: 60, h: 20, reason: "proper-noun", text: "岡田" }],
    kept: [keptUnit("保存", 0)],
  });
  const texts = file.elements.filter((e) => e.type === "text");
  const rects = file.elements.filter((e) => e.type === "rectangle");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "保存");
  assert.equal(rects.length, 1);
  assert.equal(rects[0].fillStyle, "hachure");
});

test("buildWireframe: マスクした文字列はファイルのどこにも含まれない（確定事項12）", () => {
  const file = buildWireframe({
    masks: [
      { x: 0, y: 0, w: 60, h: 20, reason: "proper-noun", text: "岡田健太" },
      { x: 0, y: 30, w: 90, h: 20, reason: "digit-run", text: "090-1234-5678" },
    ],
    kept: [keptUnit("担当", 100)],
  });
  const json = JSON.stringify(file);
  assert.ok(!json.includes("岡田健太"));
  assert.ok(!json.includes("090-1234-5678"));
  assert.ok(json.includes("担当"));
});

test("buildWireframe: 解除された自動マスク（revealed）はテキストとして出力される", () => {
  const file = buildWireframe({
    masks: [],
    kept: [],
    revealed: [{ x: 0, y: 0, w: 60, h: 20, reason: "proper-noun", text: "株式会社ABC", source: "auto" }],
  });
  const texts = file.elements.filter((e) => e.type === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "株式会社ABC");
});

test("buildWireframe: 手動マスク（text なし）は矩形として出力され、text 要素にならない", () => {
  const file = buildWireframe({
    masks: [{ x: 0, y: 0, w: 40, h: 20, source: "manual", reason: "manual" }],
    kept: [],
  });
  assert.equal(file.elements.filter((e) => e.type === "rectangle").length, 1);
  assert.equal(file.elements.filter((e) => e.type === "text").length, 0);
});

test("buildWireframe: opaque 由来のマスクは cross-hatch で塗り分けられる", () => {
  const file = buildWireframe({
    masks: [
      { x: 0, y: 0, w: 100, h: 80, reason: "opaque(img)" },
      { x: 0, y: 100, w: 60, h: 20, reason: "digit" },
    ],
    kept: [],
  });
  const [opaqueRect, maskRect] = file.elements;
  assert.equal(opaqueRect.fillStyle, "cross-hatch");
  assert.equal(maskRect.fillStyle, "hachure");
});

test("buildWireframe: decor は実際の色を持つ rectangle として最背面（先頭）に置かれる", () => {
  const file = buildWireframe({
    masks: [{ x: 0, y: 0, w: 60, h: 20, reason: "digit" }],
    kept: [keptUnit("保存", 100)],
    decor: [
      { x: 0, y: 0, w: 200, h: 100, bg: true, border: false, color: "rgb(74, 122, 184)" },
      { x: 10, y: 10, w: 50, h: 30, bg: false, border: true, color: "rgb(208, 213, 218)" },
    ],
  });
  const [bgRect, borderRect] = file.elements;
  assert.equal(bgRect.type, "rectangle");
  assert.equal(bgRect.backgroundColor, "rgb(74, 122, 184)");
  assert.equal(bgRect.fillStyle, "solid");
  assert.equal(borderRect.backgroundColor, "transparent");
  assert.equal(borderRect.strokeColor, "rgb(208, 213, 218)");
});

test("buildWireframe: scale で画像 px → CSS px に割り戻す（decor は割らない）", () => {
  const file = buildWireframe({
    masks: [{ x: 200, y: 100, w: 80, h: 40, reason: "digit" }],
    kept: [keptUnit("保存", 100, { y: 50, w: 60, h: 30 })],
    decor: [{ x: 5, y: 5, w: 10, h: 10, bg: true, border: false, color: "rgb(0,0,0)" }],
    scale: 2,
  });
  const rect = file.elements.find((e) => e.fillStyle === "hachure");
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [100, 50, 40, 20]);
  const text = file.elements.find((e) => e.type === "text");
  assert.deepEqual([text.x, text.y], [50, 25]);
  const decorRect = file.elements.find((e) => e.fillStyle === "solid");
  assert.deepEqual([decorRect.x, decorRect.y], [5, 5]);
});

test("buildWireframe: fontSize は bbox 高さ ÷ lineHeight(1.25) から算出される", () => {
  const file = buildWireframe({ masks: [], kept: [keptUnit("見出し", 0, { h: 25 })] });
  assert.equal(file.elements[0].fontSize, 20);
});

test("buildWireframe: 決定的変換（同じ入力から常に同じ出力）", () => {
  const input = () => ({
    masks: [{ x: 0, y: 0, w: 60, h: 20, reason: "digit" }],
    kept: [keptUnit("保存", 100)],
    decor: [{ x: 0, y: 0, w: 10, h: 10, bg: true, border: false, color: "rgb(1,2,3)" }],
  });
  assert.equal(JSON.stringify(buildWireframe(input())), JSON.stringify(buildWireframe(input())));
});

test("buildWireframe: blockId が groupIds に反映される", () => {
  const file = buildWireframe({
    masks: [{ x: 0, y: 30, w: 60, h: 20, reason: "digit", blockId: 3 }],
    kept: [keptUnit("保存", 0, { blockId: 3 })],
  });
  for (const e of file.elements) assert.deepEqual(e.groupIds, ["block-3"]);
});

// ---- Issue #23: アイコンの切り抜き埋め込み ----

const icon = (overrides = {}) => ({
  x: 10, y: 20, w: 16, h: 16, kind: "svg",
  dataURL: "data:image/png;base64,AAAA", ...overrides,
});

test("buildWireframe: アイコンは image 要素 + files として埋め込まれる", () => {
  const file = buildWireframe({ masks: [], kept: [], icons: [icon()] });
  const img = file.elements.find((e) => e.type === "image");
  assert.ok(img);
  assert.deepEqual([img.x, img.y, img.width, img.height], [10, 20, 16, 16]);
  assert.equal(img.status, "saved");
  assert.deepEqual(img.scale, [1, 1]);
  const entry = file.files[img.fileId];
  assert.ok(entry, "fileId が files のキーとして解決できること");
  assert.equal(entry.id, img.fileId);
  assert.equal(entry.mimeType, "image/png");
  assert.equal(entry.dataURL, "data:image/png;base64,AAAA");
});

test("buildWireframe: files の created/lastRetrieved は固定値 0（決定性）", () => {
  const file = buildWireframe({ masks: [], kept: [], icons: [icon()] });
  const entry = Object.values(file.files)[0];
  assert.equal(entry.created, 0);
  assert.equal(entry.lastRetrieved, 0);
  const again = buildWireframe({ masks: [], kept: [], icons: [icon()] });
  assert.equal(JSON.stringify(file), JSON.stringify(again));
});

test("buildWireframe: アイコン座標は CSS px のまま（scale で割らない）", () => {
  const file = buildWireframe({ masks: [], kept: [], icons: [icon()], scale: 2 });
  const img = file.elements.find((e) => e.type === "image");
  assert.deepEqual([img.x, img.y], [10, 20]);
});

test("buildWireframe: dataURL の無いアイコン（切り抜き失敗）は出力されない", () => {
  const file = buildWireframe({ masks: [], kept: [], icons: [icon({ dataURL: null })] });
  assert.equal(file.elements.filter((e) => e.type === "image").length, 0);
  assert.deepEqual(file.files, {});
});

test("buildWireframe: アイコンは装飾より前面・テキストより背面に置かれる", () => {
  const file = buildWireframe({
    masks: [],
    kept: [keptUnit("保存", 100)],
    decor: [{ x: 0, y: 0, w: 50, h: 50, bg: true, border: false, color: "rgb(1,2,3)" }],
    icons: [icon()],
  });
  const order = file.elements.map((e) => e.type + ":" + (e.fillStyle ?? ""));
  assert.deepEqual(order, ["rectangle:solid", "image:", "text:"]);
});

test("mergeTextRuns: 同一行・同一ブロックの近接テキストは 1 要素にマージされる", () => {
  // 「運用」「ダッシュボード」のようなトークン分割を 1 テキストにまとめる
  const merged = mergeTextRuns([
    keptUnit("運用", 0, { w: 30 }),
    keptUnit("ダッシュボード", 31, { w: 100 }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "運用ダッシュボード");
  assert.equal(merged[0].w, 131);
});

test("mergeTextRuns: 語間ギャップには空白が入り、大きなギャップではマージしない", () => {
  const spaced = mergeTextRuns([
    keptUnit("Sync", 0, { w: 30 }),
    keptUnit("Status", 35, { w: 40 }), // ギャップ 5px（h=15 の 1/3）→ 空白入りマージ
  ]);
  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].text, "Sync Status");

  const separate = mergeTextRuns([
    keptUnit("サービス", 0, { w: 60 }),
    keptUnit("ステータス", 200, { w: 60 }), // 別カラム相当の大ギャップ → マージしない
  ]);
  assert.equal(separate.length, 2);
});

test("mergeTextRuns: 行（y）やブロックが違えばマージしない", () => {
  const byLine = mergeTextRuns([
    keptUnit("1行目", 0),
    keptUnit("2行目", 0, { y: 20 }),
  ]);
  assert.equal(byLine.length, 2);

  const byBlock = mergeTextRuns([
    keptUnit("ブロックA", 0, { blockId: 1 }),
    keptUnit("ブロックB", 31, { blockId: 2 }),
  ]);
  assert.equal(byBlock.length, 2);
});
