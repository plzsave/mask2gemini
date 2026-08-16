// skill 同梱の語彙表が docs/m2g-schema.md と一致していることの機械的ゲート（Issue #68）。
//
// 背景: 消費側 skill（skills/m2g-wireframe/）は、受け取った人が自分のプロジェクトの
// .claude/skills/ へ**そのままコピーして使う**もの。したがって skill だけを
// 取り出しても完結している必要があり、語彙表を同梱している。
//
// 一方 SPEC の確定事項12・Issue #49 により、語彙の正は docs/m2g-schema.md で、
// 配布 zip にも docs/ として同梱される。同じ内容が 2 箇所にある構造なので、
// 「片方だけ更新して気づかない」が起きうる。ドキュメントの約束ではなく
// テストで落とす（グローバル運用方針の「機械的ゲートで担保する」に合わせる）。
//
// 直し方: cp docs/m2g-schema.md skills/m2g-wireframe/references/m2g-schema.md
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CANONICAL = path.join(ROOT, "docs", "m2g-schema.md");
const BUNDLED = path.join(ROOT, "skills", "m2g-wireframe", "references", "m2g-schema.md");

test("skill 同梱の m2g-schema.md が docs/ の正と一致する", () => {
  assert.ok(fs.existsSync(BUNDLED),
    `${path.relative(ROOT, BUNDLED)} が無い。skill 単体でコピーしても語彙表が`
    + "付いてこない状態になっている。cp docs/m2g-schema.md で復元すること");
  // 内容そのものを assert すると失敗時に 7KB の文書を 2 回ダンプして読めなくなる。
  // 一致/不一致だけ分かればよく、直し方は 1 コマンドなので差分の提示は要らない
  const bundled = fs.readFileSync(BUNDLED, "utf8");
  const canonical = fs.readFileSync(CANONICAL, "utf8");
  assert.ok(bundled === canonical,
    "docs/m2g-schema.md と skill 同梱の写しが食い違っている。次で直す:\n"
    + "  cp docs/m2g-schema.md skills/m2g-wireframe/references/m2g-schema.md");
});

test("skill が単体で完結している（参照先のファイルが揃っている）", () => {
  const skillDir = path.join(ROOT, "skills", "m2g-wireframe");
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  // SKILL.md が案内する相対パスは、skill ディレクトリだけを他プロジェクトへ
  // コピーしても解決できなければならない（これが壊れていたのが Issue #68 の初版）
  for (const rel of ["references/m2g-schema.md", "scripts/summarize-wireframe.mjs"]) {
    assert.ok(skill.includes(rel), `SKILL.md が ${rel} に言及していない`);
    assert.ok(fs.existsSync(path.join(skillDir, rel)),
      `SKILL.md は ${rel} を案内しているのに実体が無い`);
  }
});
