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
(cd "$root" && zip -qr "$out" extension)

echo "生成完了: ${out#"$root/"}"
du -h "$out" | cut -f1
