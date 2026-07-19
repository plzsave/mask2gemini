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
# （ワイヤーフレームを LLM に読ませるときに貼る文書。Issue #49）
(cd "$root" && zip -qr "$out" extension LICENSE GUIDE.html guide docs)

echo "生成完了: ${out#"$root/"}"
du -h "$out" | cut -f1
