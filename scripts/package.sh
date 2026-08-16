#!/usr/bin/env bash
# 配布用 zip を dist/ に生成する。zip には vendor 込みの extension/ を含め、
# 展開 → chrome://extensions で読み込むだけで動く状態にする。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

[ -d "$root/extension/vendor/tesseract" ] || {
  echo "extension/vendor がありません。先に bash scripts/copy-vendor.sh を実行してください" >&2
  exit 1
}

version="$(node -p "require('$root/extension/manifest.json').version")"
out="$root/dist/mask2gemini-$version.zip"

mkdir -p "$root/dist"
rm -f "$out"
# GUIDE.html + guide/ は非エンジニア向けの利用ガイド（Issue #32）。zip の受け取り手が
# 最初に開くファイルなので必ず同梱する。docs/ はエンジニア向けの m2g 規約
# （ワイヤーフレームを LLM に読ませるときに貼る文書。Issue #49）。
# skills/ は消費側 Agent が読む skill（Issue #68）。受け取った人が
# 自分のプロジェクトの .claude/skills/ へ**そのままコピーして使える**よう、
# 語彙表（references/m2g-schema.md）を同梱済みの状態でリポジトリに置いてある。
# docs/m2g-schema.md との同一性は test/schema-copy.test.js が機械的に担保する
(cd "$root" && zip -qr "$out" extension LICENSE GUIDE.html guide docs skills)

echo "生成完了: ${out#"$root/"}"
du -h "$out" | cut -f1
