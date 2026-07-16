// node --test で実行する rules.js の純関数テスト。ブラウザ/chrome API 不要。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./rules.js");
const { judge, judgeToken, findLinePatternMaskIndices } = globalThis.Mask2GeminiRules;

test("judge: 組み込みラベルは残す", () => {
  assert.deepEqual(judge("検索"), { mask: false, reason: "allowlist" });
});

test("judge: @ を含む語は塗る", () => {
  assert.equal(judge("foo@example.com").mask, true);
  assert.equal(judge("foo@example.com").reason, "at-mark");
});

test("judge: 数字を含む語は塗る", () => {
  assert.equal(judge("090-1234-5678").mask, true);
  assert.equal(judge("090-1234-5678").reason, "digit");
});

test("judge: 人名になり得る短い日本語は塗る", () => {
  assert.equal(judge("山田").mask, true);
  assert.equal(judge("山田").reason, "jp-name-like");
});

test("judge: アローリスト外の短いASCII語は長さに関わらず塗る（Issue #10）", () => {
  // "OK" は今後 UI_LABEL_ALLOWLIST に登録済みの語だけが残る前提。
  // 登録が無い短い語（人名になり得る）は塗られる
  assert.deepEqual(judge("Bob"), { mask: true, reason: "ascii-word" });
  assert.deepEqual(judge("test").mask, true);
});

test("judge: UI_LABEL_ALLOWLIST に登録済みの短いASCII略語は残す", () => {
  assert.deepEqual(judge("OK"), { mask: false, reason: "allowlist" });
  assert.deepEqual(judge("FAX"), { mask: false, reason: "allowlist" });
});

test("judge: 8文字以上は内容を問わず塗る（recall優先）", () => {
  assert.equal(judge("顧客管理システム").mask, true);
  assert.equal(judge("顧客管理システム").reason, "long-text");
});

test("judgeToken: 固有名詞は塗る", () => {
  const token = { surface_form: "田中", pos: "名詞", pos_detail_1: "固有名詞", word_type: "KNOWN" };
  assert.deepEqual(judgeToken(token), { mask: true, reason: "proper-noun" });
});

test("judgeToken: 住所の行政区画接尾辞（都道府県市区町村郡）は一般名詞判定でも塗る", () => {
  // kuromoji は「東京都」を固有名詞「東京」+ 一般名詞「都」に分割する（Issue #5）
  for (const suffix of ["都", "道", "府", "県", "市", "区", "町", "村", "郡"]) {
    const token = { surface_form: suffix, pos: "名詞", pos_detail_1: "一般", word_type: "KNOWN" };
    assert.deepEqual(
      judgeToken(token), { mask: true, reason: "address-suffix" },
      `"${suffix}" が塗られていること`);
  }
});

test("judgeToken: 記号のみのトークンは残す", () => {
  const token = { surface_form: "-", pos: "記号", pos_detail_1: "*", word_type: "UNKNOWN" };
  assert.equal(judgeToken(token).mask, false);
});

test("judgeToken: 未知語（英語の長い語）は塗る", () => {
  const token = { surface_form: "Overview", pos: "名詞", pos_detail_1: "一般", word_type: "UNKNOWN" };
  assert.equal(judgeToken(token).mask, true);
  assert.equal(judgeToken(token).reason, "long-text"); // 8文字以上は長さで先に落ちる
});

test("judgeToken: アローリスト登録済みの短いASCII略語（FAX等）は残す", () => {
  const token = { surface_form: "FAX", pos: "名詞", pos_detail_1: "一般", word_type: "UNKNOWN" };
  assert.deepEqual(judgeToken(token), { mask: false, reason: "allowlist" });
});

test("judgeToken: アローリスト外の短い英語名は塗る（Issue #10）", () => {
  // kuromoji は "Bob" のような未知の短い英単語を 名詞/固有名詞/UNKNOWN と推定する
  // （"OK"/"FAX" 等の実用略語と同じシグネチャ。区別できないため長さでは救済しない）
  const token = { surface_form: "Bob", pos: "名詞", pos_detail_1: "固有名詞", word_type: "UNKNOWN" };
  assert.deepEqual(judgeToken(token), { mask: true, reason: "proper-noun" });
});

test("judgeToken: 一般語（辞書に載っている語）は残す", () => {
  const token = { surface_form: "です", pos: "助動詞", pos_detail_1: "*", word_type: "KNOWN" };
  assert.equal(judgeToken(token).mask, false);
});

test("findLinePatternMaskIndices: 断片化したメールを行結合で検出する", () => {
  const units = [{ text: "foo" }, { text: "@" }, { text: "bar" }, { text: "." }, { text: "com" }];
  const hits = findLinePatternMaskIndices(units);
  assert.equal(hits.size, units.length);
  for (const [, reason] of hits) assert.equal(reason, "email");
});

test("findLinePatternMaskIndices: 単体では拾えない短いドメイン断片も拾う", () => {
  // "bar" は judge() 単体では short-ascii（残す）判定になるが、
  // 行結合でメール全体として検出されればマスク対象に回収されるべき
  const units = [{ text: "foo@" }, { text: "bar" }, { text: ".com" }];
  const hits = findLinePatternMaskIndices(units);
  assert.equal(hits.size, 3);
});

test("findLinePatternMaskIndices: メールを含まない行はヒットしない", () => {
  const units = [{ text: "保存" }, { text: "しました" }];
  assert.equal(findLinePatternMaskIndices(units).size, 0);
});

test("findLinePatternMaskIndices: アンダースコアを含むローカルパートも一致する", () => {
  const units = [{ text: "sayuri_kobayashi+work@mail.example.io" }];
  const hits = findLinePatternMaskIndices(units);
  assert.equal(hits.size, 1);
  assert.equal(hits.get(0), "email");
});

// ---- Issue #1: digit-run（数字+区切り文字のラン全体を行結合で塗る） ----

test("digit-run: トークン分割された電話番号は区切り文字ごと塗られる", () => {
  const units = [{ text: "090" }, { text: "-" }, { text: "1234" }, { text: "-" }, { text: "5678" }];
  const hits = findLinePatternMaskIndices(units);
  assert.equal(hits.size, units.length, "区切りの - も含め全 unit が塗られること");
  for (const [, reason] of hits) assert.equal(reason, "digit-run");
});

test("digit-run: 表記ゆれ（かっこ・国番号・郵便マーク・全角）も一致する", () => {
  const cases = [
    ["(", "03", ")", "1234", "-", "5678"],
    ["+", "81", "-", "90", "-", "1234", "-", "5678"],
    ["〒", "150", "-", "0001"],
    ["０９０", "－", "１２３４", "－", "５６７８"], // 全角数字＋全角ハイフン
    ["〒", "１５０", "ー", "０００１"], // 長音記号を区切りに使った全角郵便番号
    ["2026", "/", "07", "/", "15"], // 日付
  ];
  for (const texts of cases) {
    const units = texts.map((text) => ({ text }));
    const hits = findLinePatternMaskIndices(units);
    assert.equal(hits.size, units.length, `${texts.join("")} は全 unit が塗られること`);
  }
});

test("digit-run: 数字を含まない行・数字1個だけの語はヒットしない", () => {
  assert.equal(findLinePatternMaskIndices([{ text: "保存" }, { text: "しました" }]).size, 0);
  // 「第1章」: 数字が1個だけのランは対象外（トークン側 digit ルールが「1」を塗る）
  const hits = findLinePatternMaskIndices([{ text: "第" }, { text: "1" }, { text: "章" }]);
  assert.equal(hits.size, 0);
});

test("digit-run: 同一行のメールと電話が別 reason で共存する", () => {
  const units = [
    { text: "foo@" }, { text: "bar" }, { text: ".com" },
    { text: "／" },
    { text: "03" }, { text: "-" }, { text: "1234" }, { text: "-" }, { text: "5678" },
  ];
  const hits = findLinePatternMaskIndices(units);
  assert.equal(hits.get(0), "email");
  assert.equal(hits.get(2), "email");
  assert.equal(hits.get(4), "digit-run");
  assert.equal(hits.get(7), "digit-run", "電話番号内の区切り - も塗られること");
});

// ---- findKanjiNameRunIndices（Issue #10 事象1: 漢字名ラン検出） ----
// kuromoji の実出力（本ファイル冒頭のテストと同様、実測値ベース）を模した
// 疑似トークンで検証する
const runUnit = (surface, pos, detail, word_type = "KNOWN") => ({
  text: surface,
  token: { surface_form: surface, pos, pos_detail_1: detail, word_type },
});
const spaceUnit = () => runUnit(" ", "記号", "空白", "UNKNOWN");
const { findKanjiNameRunIndices } = globalThis.Mask2GeminiRules;

test("kanji-run: 王偉（1字名詞・一般 + 形容詞・自立）を検出する", () => {
  const units = [runUnit("王", "名詞", "一般"), runUnit("偉", "形容詞", "自立")];
  const result = findKanjiNameRunIndices(units);
  assert.deepEqual([...result.keys()], [0, 1]);
  assert.equal(result.get(0), "kanji-run");
});

test("kanji-run: 空白を挟んだ「王 偉」もランを切らず空白ごと検出する", () => {
  // kuromoji は半角/全角スペースを独立トークン（記号/空白）にする（実測）
  const units = [runUnit("王", "名詞", "固有名詞"), spaceUnit(), runUnit("偉", "形容詞", "自立")];
  const result = findKanjiNameRunIndices(units);
  assert.deepEqual([...result.keys()], [0, 1, 2], "姓名間の空白も含めて塗る（隙間の塗り残し防止）");
});

test("kanji-run: 陳建国（固有名詞アンカー + サ変接続）を検出する", () => {
  const units = [runUnit("陳", "名詞", "固有名詞"), runUnit("建国", "名詞", "サ変接続")];
  assert.equal(findKanjiNameRunIndices(units).size, 2);
});

test("kanji-run: 顧客管理（2字+2字の一般語複合・アンカー無し）は検出しない", () => {
  const units = [runUnit("顧客", "名詞", "一般"), runUnit("管理", "名詞", "サ変接続")];
  assert.equal(findKanjiNameRunIndices(units).size, 0);
});

test("kanji-run: 接尾辞はメンバーにならずランを切る（承認者・東京都・営業部）", () => {
  for (const [a, ad, b, bd] of [
    ["承認", "サ変接続", "者", "接尾"],
    ["東京", "固有名詞", "都", "接尾"],
    ["営業", "サ変接続", "部", "接尾"],
  ]) {
    const units = [runUnit(a, "名詞", ad), runUnit(b, "名詞", bd)];
    assert.equal(findKanjiNameRunIndices(units).size, 0, `${a}${b} は塗らない`);
  }
});

test("kanji-run: 接頭詞・数はメンバーにならない（第二営業部）", () => {
  const units = [
    runUnit("第", "接頭詞", "数接続"), runUnit("二", "名詞", "数"),
    runUnit("営業", "名詞", "サ変接続"), runUnit("部", "名詞", "接尾"),
  ];
  assert.equal(findKanjiNameRunIndices(units).size, 0);
});

test("kanji-run: 漢字合計5文字以上の連結は複合名詞とみなし検出しない", () => {
  const units = [
    runUnit("王", "名詞", "一般"), runUnit("偉", "形容詞", "自立"),
    runUnit("委員会", "名詞", "一般"), // 合計 5 文字
  ];
  assert.equal(findKanjiNameRunIndices(units).size, 0);
});

test("kanji-run: 漢字以外（かな混じり・カタカナ）のトークンはランを切る", () => {
  const units = [
    runUnit("偉い", "形容詞", "自立"), runUnit("人", "名詞", "一般"),
  ];
  assert.equal(findKanjiNameRunIndices(units).size, 0, "メンバー1つでは成立しない");
});

test("kanji-run: token の無い unit（OCR単語フォールバック）はランを構成しない", () => {
  const units = [
    runUnit("王", "名詞", "一般"),
    { text: "偉", token: null },
  ];
  assert.equal(findKanjiNameRunIndices(units).size, 0);
});

test("kanji-run: 山田 太郎（固有名詞ペア）もランになる（空白の隙間対策を兼ねる）", () => {
  const units = [runUnit("山田", "名詞", "固有名詞"), spaceUnit(), runUnit("太郎", "名詞", "固有名詞")];
  assert.equal(findKanjiNameRunIndices(units).size, 3);
});
