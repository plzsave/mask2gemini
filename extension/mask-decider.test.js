// node --test で実行する mask-decider.js の統合テスト（review.js の判定ループを
// DOM/chrome/OCR 抜きで検証する）。rules.js・allowlist.js の実装をそのまま使う。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./rules.js");
require("./allowlist.js");
require("./mask-decider.js");

const { judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
  UI_LABEL_ALLOWLIST } = globalThis.Mask2GeminiRules;
const { findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;
const { lineToUnits, decideParagraphMasks } = globalThis.Mask2GeminiMaskDecider;

const baseDeps = (overrides = {}) => ({
  judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
  findProtectedWordIndices,
  userTerms: [],
  labelTerms: [...UI_LABEL_ALLOWLIST],
  noiseConfidence: 35,
  ocrScale: 2,
  maskPadding: 3,
  ...overrides,
});

// bbox は OCR_SCALE=2 前提の座標系で組み立てる（テスト用の簡易値）
const unit = (text, { confidence = 90, x0 = 0, semantic = null } = {}) => ({
  text, confidence, bbox: { x0, y0: 0, x1: x0 + 10, y1: 10 }, token: null, semantic,
});

test("lineToUnits: tokenizer が無ければ OCR word 単位のまま返す", () => {
  const line = { words: [{ text: "保存", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90 }] };
  const units = lineToUnits(line, null);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "保存");
  assert.equal(units[0].token, null);
});

test("lineToUnits: line.semantic は各 unit に引き継がれる（DOM 経路。tokenizer 無し）", () => {
  const line = {
    semantic: "data",
    words: [{ text: "山田太郎", bbox: { x0: 0, y0: 0, x1: 40, y1: 10 }, confidence: 100 }],
  };
  const units = lineToUnits(line, null);
  assert.equal(units[0].semantic, "data");
});

test("lineToUnits: OCR 経路（semantic 無し）の unit は semantic=null になる", () => {
  const line = { words: [{ text: "保存", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90 }] };
  assert.equal(lineToUnits(line, null)[0].semantic, null);
});

// ---- 確定事項11: DOM 要素種別レベルの構造判定 ----

test("decideParagraphMasks: semantic=data はテキスト判定が「残す」でも塗る（td 内の UI ラベル語等）", () => {
  // 「保存」は UI ラベル辞書にあり judge では残る判定だが、td 内にあるならデータ
  const units = [unit("保存", { semantic: "data" })];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "dom-data");
  assert.ok(decisions[0].includes("塗:dom-data"));
});

test("decideParagraphMasks: semantic=label は辞書に無い見出し語でも残す", () => {
  // "Widgetzone" は judge では ascii-word として塗られるが、th/ボタン内なら残す
  const units = [unit("Widgetzone", { semantic: "label" })];
  const { masks, kept } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reason, "dom-label");
});

test("decideParagraphMasks: semantic=label でも数字を含む語は塗る（isDataLike が保護に勝つ）", () => {
  const units = [unit("2024年度", { semantic: "label" })];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.match(masks[0].reason, /^digit/); // digit または digit-run（行結合が先に拾う）
});

test("decideParagraphMasks: ユーザー登録語は semantic=data より優先して残る（確定事項8）", () => {
  const units = [unit("株式会社ABC", { semantic: "data" })];
  const { masks, kept } = decideParagraphMasks(units, baseDeps({ userTerms: ["株式会社ABC"] }));
  assert.equal(masks.length, 0);
  assert.equal(kept[0].reason, "user");
});

test("decideParagraphMasks: semantic=data はテキスト判定で塗られる場合も通常の reason で塗る", () => {
  // dom-data は「構造だけが根拠」のときの reason。テキスト自体がデータらしい場合は
  // 本来の reason（デバッグオーバーレイでの原因追跡用）を保つ
  const units = [unit("foo@bar.com", { semantic: "data" })];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "email");
});

test("decideParagraphMasks: 断片化したメールは行(段落)結合で1つの矩形として塗られる", () => {
  const units = [unit("foo@", { x0: 0 }), unit("bar", { x0: 10 }), unit(".com", { x0: 20 })];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  // Issue #1: 同一行内で連続する一致範囲はトークン間の空白ごと1矩形にマージされる
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "email");
  assert.equal(masks[0].text, "foo@bar.com");
  // 矩形が全断片の bbox を覆っている（x0=0-10px 〜 x1=30px を ocrScale=2 で割り padding=3）
  assert.ok(masks[0].x <= 0 && masks[0].x + masks[0].w >= 15);
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
  const addressMask = masks.find((m) => m.text.includes("address"));
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

// Issue #3: 行結合パターン判定（linePatternReason）は個別トークンの
// NOISE_CONFIDENCE フィルタより必ず先に確定し、そのフィルタを無条件にバイパスする。
// 断片の一部が低信頼度でも、パターンとして成立していれば confidence を割り引かず
// 全断片を塗る（SPEC.md 確定事項2: recall優先）ことをロックインする
test("decideParagraphMasks: 行結合パターンは断片の一部が低信頼度でも confidence を割り引かず全て塗る", () => {
  const units = [
    unit("foo@", { x0: 0, confidence: 90 }),
    unit("bar", { x0: 10, confidence: 2 }), // ノイズ並みの低信頼度（noiseConfidence=35未満）
    unit(".com", { x0: 20, confidence: 90 }),
  ];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "email");
  assert.equal(masks[0].text, "foo@bar.com", "低信頼度断片もマージ結果に含まれる");
  assert.ok(decisions.every((d) => d.includes("塗:email")), "低信頼度断片も noise としてスキップされない");
});

// Issue #1: digit-run（電話番号等のトークン分割）も行結合パターンとして
// email と同じ優先順位（noise フィルタ・ラベル保護より先に確定）で塗られる
test("decideParagraphMasks: 分割された電話番号は区切りトークンが低信頼度でも全て塗られる", () => {
  const units = [
    unit("090", { x0: 0, confidence: 90 }),
    unit("-", { x0: 10, confidence: 2 }), // 区切り記号は OCR 信頼度が落ちやすい
    unit("1234", { x0: 20, confidence: 90 }),
    unit("-", { x0: 30, confidence: 2 }),
    unit("5678", { x0: 40, confidence: 90 }),
  ];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1, "区切り・空白ごと1矩形にマージされること");
  assert.equal(masks[0].reason, "digit-run");
  assert.equal(masks[0].text, "090-1234-5678");
  // 矩形が先頭 090 から末尾 5678 まで（x0=0 〜 x1=50px、ocrScale=2）を覆う
  assert.ok(masks[0].x <= 0 && masks[0].x + masks[0].w >= 25);
  assert.ok(decisions.every((d) => d.includes("塗:digit-run")));
});

test("decideParagraphMasks: 折り返しで別の行に分かれた一致範囲は行ごとに別矩形になる", () => {
  // email-wrap 相当: 一致範囲が2つの OCR 行にまたがる場合、union すると
  // 行間の無関係なテキストまで塗ってしまうため、垂直に重ならない断片は分割する
  const line2 = { y0: 20, y1: 30 };
  const units = [
    { text: "foo@", confidence: 90, token: null, bbox: { x0: 0, y0: 0, x1: 40, y1: 10 } },
    { text: "example", confidence: 90, token: null, bbox: { x0: 0, ...line2, x1: 70 } },
    { text: ".com", confidence: 90, token: null, bbox: { x0: 70, ...line2, x1: 110 } },
  ];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 2);
  assert.deepEqual(masks.map((m) => m.text), ["foo@", "example.com"]);
});

test("decideParagraphMasks: ラベル辞書保護は digit-run トークンには効かない（isDataLike）", () => {
  // 仮にラベル辞書に数字入りフレーズが紛れても、行結合でデータと判定された
  // トークンの保護には使えない（ユーザー登録語のみが digit-run に勝てる）
  const units = [unit("090", { x0: 0 }), unit("-", { x0: 10 }), unit("1234", { x0: 20 })];
  const { masks } = decideParagraphMasks(units, baseDeps({ labelTerms: ["090-1234"] }));
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "digit-run");
  assert.equal(masks[0].text, "090-1234");
});

test("decideParagraphMasks: kept に非マスクトークンの reason と bbox が入る", () => {
  const units = [unit("検索")]; // UIラベル辞書によって残るケース
  const { masks, kept } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "検索");
  assert.equal(kept[0].reason, "allowlist");
  assert.ok(Number.isFinite(kept[0].x) && Number.isFinite(kept[0].w));
});

test("decideParagraphMasks: labelTerms によるフレーズ保護は kept に reason=label で入る", () => {
  // "Widgetzone" は既定の UI_LABEL_ALLOWLIST に無い ascii-word（judge() は塗る判定になる）が、
  // labelTerms 経由のフレーズ照合で保護されるケースを直接検証する
  const units = [unit("Widgetzone")];
  const { masks, kept } = decideParagraphMasks(units, baseDeps({ labelTerms: ["widgetzone"] }));
  assert.equal(masks.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reason, "label");
});

test("decideParagraphMasks: マスクされたトークンは kept に入らない", () => {
  const units = [unit("foo@bar.com")];
  const { masks, kept } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.equal(kept.length, 0);
});

test("decideParagraphMasks: noise は kept に動的な reason 文字列のまま入る", () => {
  const units = [unit("巡", { confidence: 2 })];
  const { kept } = decideParagraphMasks(units, baseDeps());
  assert.equal(kept.length, 1);
  assert.match(kept[0].reason, /^noise\(\d+\)$/);
});

test("reasonColorHue: 同じ reason は常に同じ色相を返す（決定的）", () => {
  const { reasonColorHue } = globalThis.Mask2GeminiMaskDecider;
  assert.equal(reasonColorHue("email"), reasonColorHue("email"));
});

test("reasonColorHue: noise(n) は n の値に関わらず同じ色相系列になる", () => {
  const { reasonColorHue } = globalThis.Mask2GeminiMaskDecider;
  assert.equal(reasonColorHue("noise(23)"), reasonColorHue("noise(90)"));
});

test("reasonColorHue: 0-359 の範囲に収まる", () => {
  const { reasonColorHue } = globalThis.Mask2GeminiMaskDecider;
  for (const r of ["email", "pos:動詞", "digit", "unknown-token"]) {
    const hue = reasonColorHue(r);
    assert.ok(hue >= 0 && hue < 360);
  }
});

// ---- Issue #10 事象1: 漢字名ラン（kanji-run）の統合テスト ----
// judgeToken が「残す」判定を返す一般語トークンの連結が、文脈（人名らしきラン）で
// 塗られること、および保護（ユーザー登録・ラベル辞書・DOMラベル・ノイズ）が
// digit-run と違いすべて勝つことを検証する
const kanjiUnit = (surface, pos, detail, { x0 = 0, confidence = 90, semantic = null } = {}) => ({
  text: surface, confidence, semantic,
  bbox: { x0, y0: 0, x1: x0 + 10, y1: 10 },
  token: { surface_form: surface, pos, pos_detail_1: detail, word_type: "KNOWN" },
});

test("kanji-run: 王偉は judgeToken が残す判定でも塗られ、1矩形にマージされる", () => {
  const units = [
    kanjiUnit("王", "名詞", "一般", { x0: 0 }),
    kanjiUnit("偉", "形容詞", "自立", { x0: 10 }),
  ];
  const { masks, decisions } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 1);
  assert.equal(masks[0].reason, "kanji-run");
  assert.equal(masks[0].text, "王偉");
  assert.ok(decisions.every((d) => d.includes("塗:kanji-run")));
});

test("kanji-run: ユーザー登録語が勝つ（確定事項8）", () => {
  const units = [
    kanjiUnit("王", "名詞", "一般", { x0: 0 }),
    kanjiUnit("偉", "形容詞", "自立", { x0: 10 }),
  ];
  const { masks } = decideParagraphMasks(units, baseDeps({ userTerms: ["王偉"] }));
  assert.equal(masks.length, 0);
});

test("kanji-run: ラベル辞書のフレーズ保護が勝つ（digit-run と異なり data-like ではない）", () => {
  const units = [
    kanjiUnit("王", "名詞", "一般", { x0: 0 }),
    kanjiUnit("偉", "形容詞", "自立", { x0: 10 }),
  ];
  const { masks, kept } = decideParagraphMasks(units, baseDeps({ labelTerms: ["王偉"] }));
  assert.equal(masks.length, 0);
  // judgeToken が先に「残す」を返すため kept の reason は pos:* になる
  // （ラベル保護は kanji-run の適用を止める役割で効いている）
  assert.equal(kept.length, 2);
});

test("kanji-run: DOM ラベル位置（semantic=label）が勝つ", () => {
  const units = [
    kanjiUnit("王", "名詞", "一般", { x0: 0, semantic: "label" }),
    kanjiUnit("偉", "形容詞", "自立", { x0: 10, semantic: "label" }),
  ];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
});

test("kanji-run: 低信頼度トークン（OCRノイズ）には適用しない", () => {
  const units = [
    kanjiUnit("王", "名詞", "一般", { x0: 0, confidence: 2 }),
    kanjiUnit("偉", "形容詞", "自立", { x0: 10, confidence: 2 }),
  ];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
});

test("kanji-run: 顧客管理（アンカー無しの一般語複合）は従来どおり残る", () => {
  const units = [
    kanjiUnit("顧客", "名詞", "一般", { x0: 0 }),
    kanjiUnit("管理", "名詞", "サ変接続", { x0: 10 }),
  ];
  const { masks } = decideParagraphMasks(units, baseDeps());
  assert.equal(masks.length, 0);
});

test("kanji-run: findKanjiNameRunIndices が deps に無い場合も動く（後方互換）", () => {
  const units = [unit("検索")];
  const deps = baseDeps();
  delete deps.findKanjiNameRunIndices;
  const { masks } = decideParagraphMasks(units, deps);
  assert.equal(masks.length, 0);
});
