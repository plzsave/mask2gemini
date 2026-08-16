#!/usr/bin/env node
// mask2gemini が出力した .excalidraw を、実装資料として読める形に要約する。
//
// 生 JSON は 1 画面で数十〜数百要素・数十 KB になり、そのまま読むと
// 「既存構造」と「人間が描き足した提案」の区別が埋もれる。この 2 つを
// 分けて出すことがこのスクリプトの目的（SKILL.md「2 つの層」参照）。
//
// 使い方: node summarize-wireframe.mjs <file.excalidraw>
// 依存なし・読み取りのみ。
//
// 出力は 1 種類（人間と LLM がそのまま読む文章）に絞ってある。機械可読な
// JSON 出力も付けられるが、2 経路あると「片方にしか無い情報」が生まれ、
// 実際にそれをやったところ複製検出の節が JSON 側から丸ごと欠けた。
// 読む相手が LLM である以上、文章のほうが情報を落とさずに済む。

import { readFileSync } from "node:fs";

const [, , file] = process.argv;
if (!file) {
  console.error("使い方: node summarize-wireframe.mjs <file.excalidraw>");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(file, "utf8"));
const elements = doc.elements ?? [];
if (doc.source !== "mask2gemini") {
  console.error(`警告: source が "mask2gemini" ではありません（${doc.source ?? "無し"}）。`
    + "mask2gemini の出力でない可能性があります。");
}

const m2g = (e) => e.customData?.m2g;
const roleOf = (e) => m2g(e)?.role ?? null;
const pos = (e) => `(${Math.round(e.x)},${Math.round(e.y)})`;
const size = (e) => `${Math.round(e.width)}x${Math.round(e.height)}`;
const blockOf = (e) => (e.groupIds ?? []).find((g) => g.startsWith("block-")) ?? null;

// 撮影された画面（role: "screen"）は必ず 1 枚・最背面。寸法と地色の基準になる
const screen = elements.find((e) => roleOf(e) === "screen");

// 列ヘッダの索引: 同じ tableId・同じ col の見出しテキストが、そのセルの見出し。
// マスク枠にどんなダミーを入れるかの最も確実な手がかり。
//
// 素朴に「kind が th/columnheader なら見出し」とすると 2 つ間違える:
// 1. `<th scope="row">`（行見出し）も kind は "th" になる（dom-extractor の
//    LABEL_TAGS はタグ名で判定するため）。行見出しは各データ行の col 0 に
//    現れるので、そのまま索引に入れると本物の col 0 見出しを上書きする
// 2. 見出しが自動マスクされて確認画面で解除された場合、role は "text" ではなく
//    "revealed" になる（docs/m2g-schema.md: revealed は text と同様に扱ってよい）
//
// そこで「テーブルごとに、見出し候補のうち最も上の帯にあるものだけを列見出しと
// する」ことで行見出しを除く。上下関係で判定するので、要素の並び順にも依存しない。
const headerCandidates = new Map(); // tableId -> 候補要素[]
for (const e of elements) {
  const m = m2g(e);
  if (!m || (m.role !== "text" && m.role !== "revealed")) continue;
  if (m.tableId === undefined || m.col === undefined) continue;
  if (m.kind !== "th" && m.kind !== "columnheader") continue;
  if (!headerCandidates.has(m.tableId)) headerCandidates.set(m.tableId, []);
  headerCandidates.get(m.tableId).push(e);
}

const headers = new Map();
for (const [tableId, cands] of headerCandidates) {
  const topY = Math.min(...cands.map((c) => c.y));
  for (const c of cands) {
    // 見出し行の帯（最上段の候補と縦に重なるもの）だけを列見出しとして採用する。
    // 下の行に現れる行見出しはここで落ちる
    if (c.y >= topY + Math.max(c.height, 1)) continue;
    const key = `${tableId}:${m2g(c).col}`;
    if (!headers.has(key)) headers.set(key, c.text);
  }
}
const headerFor = (m) =>
  (m?.tableId === undefined || m?.col === undefined)
    ? null : headers.get(`${m.tableId}:${m.col}`) ?? null;

// 抽出由来（既存構造）と、人間が描き足した提案（customData 無し）に分ける。
// この区別がファイル中の唯一の「やるべきこと」の在処なので最初に出す
const extracted = elements.filter((e) => m2g(e) && roleOf(e) !== "screen");
const proposals = elements.filter((e) => !m2g(e));

const describe = (e) => {
  const m = m2g(e);
  const parts = [];
  if (m.kind) parts.push(`kind=${m.kind}`);
  if (m.reason) parts.push(`reason=${m.reason}`);
  // 列ヘッダ自身に「列ヘッダ=自分」と付けても情報量が無いので、
  // 見出しではない要素（データセルのマスク等）にだけ対応づけを出す
  const isHeader = ["th", "columnheader", "rowheader"].includes(m.kind);
  const h = isHeader ? null : headerFor(m);
  if (h) parts.push(`列ヘッダ="${h}"`);
  const tail = parts.length ? `  ${parts.join(" ")}` : "";
  if (m.role === "text" || m.role === "revealed") return `"${e.text}"${tail}`;
  return tail.trim() || "(情報なし)";
};

const byPosition = (a, b) => (a.y - b.y) || (a.x - b.x);

// 矢印・線・コンテナの結び先（id 参照）を、読んで分かる説明に解決する。
// 提案の矢印は「既存のどの要素に対する指示か」がすべてなので、
// id のまま出しても意味がない
const byId = new Map(elements.map((e) => [e.id, e]));
const targetOf = (id) => {
  const t = byId.get(id);
  if (!t) return `(未解決の参照 ${id})`;
  const m = m2g(t);
  const where = `${t.type} ${pos(t)}`;
  if (!m) return `提案要素: ${where}${t.text ? ` "${t.text}"` : ""}`;
  return `既存要素: ${m.role} ${where} ${describe(t)}`;
};

console.log(`ファイル: ${file}`);
if (screen) {
  console.log(`画面: ${Math.round(screen.width)} x ${Math.round(screen.height)} CSS px`
    + ` / 地色 ${screen.backgroundColor}`);
} else {
  console.log("画面: role:\"screen\" が無い（OCR フォールバック経路の出力）。"
    + "寸法・地色の基準が取れないので配色は decor から読むこと");
}

// --- 提案差分（先に出す。ここが実装すべきもの） ---
console.log(`\n=== 実装すべき差分（customData 無し）: ${proposals.length} 要素 ===`);
if (proposals.length === 0) {
  console.log("新規に描き足された要素は無い。ただし削除・移動・複製による提案は"
    + "この方法では検出できないので、「提案が無い」と断定はできない。");
  console.log("実装に入る前に、下の構造の要約を示して依頼者に確認すること。");
} else {
  for (const e of [...proposals].sort(byPosition)) {
    const label = e.text ? ` "${e.text}"` : "";
    console.log(`  ${e.type.padEnd(9)} ${pos(e)} ${size(e)}${label}`);
    // 矢印・線は「どこからどこへ」に意味がある。bbox だけを出すと
    // 「この要素をここへ移せ」という指示が読めなくなるので、
    // 結びついている相手を解決して見せる
    for (const [side, b] of [["始点", e.startBinding], ["終点", e.endBinding]]) {
      if (b?.elementId) console.log(`      ${side} → ${targetOf(b.elementId)}`);
    }
    if (e.containerId) console.log(`      所属 → ${targetOf(e.containerId)}`);
  }
  console.log("\n注: 座標・寸法は配置の見当をつけるためのもので、規範ではない"
    + "（SKILL.md「何が規範で、何が規範でないか」参照）。");
}

// --- 既存構造 ---
const counts = extracted.reduce((acc, e) => {
  acc[roleOf(e)] = (acc[roleOf(e)] ?? 0) + 1;
  return acc;
}, {});
console.log(`\n=== 既存の画面構造（customData.m2g あり）: ${extracted.length} 要素 ===`);
console.log(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" / "));

// テキストとマスクをブロック（元画面のカード・セル単位）にまとめて読む。
// 装飾は数が多く個別には意味が薄いので、色の分布だけ後でまとめる
const structural = extracted.filter((e) => ["text", "revealed", "masked", "icon"].includes(roleOf(e)));
const blocks = new Map();
for (const e of structural) {
  const key = blockOf(e) ?? "(ブロック無し)";
  if (!blocks.has(key)) blocks.set(key, []);
  blocks.get(key).push(e);
}
const ordered = [...blocks.entries()].sort((a, b) => {
  const ay = Math.min(...a[1].map((e) => e.y)), by = Math.min(...b[1].map((e) => e.y));
  const ax = Math.min(...a[1].map((e) => e.x)), bx = Math.min(...b[1].map((e) => e.x));
  return (ay - by) || (ax - bx);
});

console.log("\n--- ブロック（groupIds の block-N = 元画面のカード・セル単位）---");
for (const [key, items] of ordered) {
  const x0 = Math.min(...items.map((e) => e.x)), y0 = Math.min(...items.map((e) => e.y));
  console.log(`\n[${key}] ${pos({ x: x0, y: y0 })}`);
  for (const e of [...items].sort(byPosition)) {
    console.log(`  ${roleOf(e).padEnd(8)} ${describe(e)}`);
  }
}

// テーブルの列ごとのデータ枠の数。
// Excalidraw で既存要素を複製した提案は customData ごとコピーされるため、
// 「customData の有無」では差分に現れない（SKILL.md「この見分け方が効かない場合」）。
// 複製を機械的に見分けることはできないので、代わりに数を見せて人に確認させる
const cells = extracted.filter((e) => {
  const m = m2g(e);
  return m?.role === "masked" && m.tableId !== undefined && m.col !== undefined;
});
if (cells.length) {
  const perTable = new Map();
  for (const e of cells) {
    const m = m2g(e);
    if (!perTable.has(m.tableId)) perTable.set(m.tableId, new Map());
    const cols = perTable.get(m.tableId);
    cols.set(m.col, (cols.get(m.col) ?? 0) + 1);
  }
  console.log("\n--- テーブルの列ごとのデータ枠の数（依頼者への確認用）---");
  for (const [tableId, cols] of [...perTable.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`table ${tableId}:`);
    for (const [col, n] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      const h = headers.get(`${tableId}:${col}`);
      console.log(`  col ${col} ${h ? `"${h}"` : "(見出し不明)"}: ${n} 枠`);
    }
  }
  console.log("注: マスクはトークン単位なので 1 セルが複数の枠に割れることがある。"
    + "枠の数は行数ではない。");
  console.log("注: 複製ベースで追加された提案はメタデータを引き継ぐため、"
    + "差分として自動検出できない。この数が意図どおりかを依頼者に確認すること。");
}

// 装飾（配色の根拠）。個々の矩形ではなく色の分布として出す
const decor = extracted.filter((e) => roleOf(e) === "decor");
if (decor.length) {
  const colors = new Map();
  for (const e of decor) {
    for (const c of [e.backgroundColor, e.strokeColor]) {
      if (!c || c === "transparent") continue;
      colors.set(c, (colors.get(c) ?? 0) + 1);
    }
  }
  const sorted = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n--- 配色（decor ${decor.length} 要素の実測色。多い順）---`);
  console.log(sorted.map(([c, n]) => `${c}(${n})`).join(" "));
  // 細長い decor は元ページの 1 辺だけの border＝区切り線として出ている
  const dividers = decor.filter((e) => e.height <= 4 || e.width <= 4);
  if (dividers.length) console.log(`うち区切り線（細長い矩形）: ${dividers.length} 本`);
}
