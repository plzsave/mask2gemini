#!/usr/bin/env bash
# node_modules から拡張の vendor/ へ tesseract.js 一式をコピーする。
# ネットワークアクセスは行わない（言語データも npm パッケージから取る）。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
nm="$root/node_modules"
vendor="$root/extension/vendor"

[ -d "$nm/tesseract.js" ] || { echo "node_modules がありません。先に bun install を実行してください" >&2; exit 1; }

rm -rf "$vendor"
mkdir -p "$vendor/tesseract" "$vendor/core" "$vendor/lang"

# 本体（メインスレッド用 UMD）と worker
cp "$nm/tesseract.js/dist/tesseract.min.js" "$vendor/tesseract/"
cp "$nm/tesseract.js/dist/worker.min.js" "$vendor/tesseract/"

# WASM コア。worker が環境に応じて *.wasm.js を選択し、対応する .wasm を読む
cp "$nm"/tesseract.js-core/tesseract-core*.wasm.js "$vendor/core/"
cp "$nm"/tesseract.js-core/tesseract-core*.wasm "$vendor/core/"

# 言語データ（OEM=LSTM_ONLY 用の best_int）
cp "$nm/@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz" "$vendor/lang/"
cp "$nm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz" "$vendor/lang/"

# 形態素解析（kuromoji.js: ブラウザ用ビルドと IPADIC 辞書）
mkdir -p "$vendor/kuromoji/dict"
cp "$nm/kuromoji/build/kuromoji.js" "$vendor/kuromoji/"
cp "$nm"/kuromoji/dict/*.dat.gz "$vendor/kuromoji/dict/"

# 再頒布物なので各ライブラリの LICENSE / NOTICE を同梱する
cp "$nm/tesseract.js/LICENSE.md" "$vendor/tesseract/"
cp "$nm/tesseract.js-core/LICENSE" "$vendor/core/"
cp "$nm/kuromoji/LICENSE-2.0.txt" "$nm/kuromoji/NOTICE.md" "$vendor/kuromoji/"

# 同梱パッケージの一覧（名前・バージョン・ライセンス）を package.json から生成
node -e '
  const pkgs = ["tesseract.js", "tesseract.js-core",
    "@tesseract.js-data/jpn", "@tesseract.js-data/eng", "kuromoji"];
  const lines = pkgs.map((p) => {
    const j = require(process.argv[1] + "/" + p + "/package.json");
    const repo = (j.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    return `- ${j.name}@${j.version} (${j.license}) ${repo}`;
  });
  console.log(["This distribution bundles the following third-party packages:", "", ...lines].join("\n"));
' "$nm" > "$vendor/THIRD-PARTY-NOTICES.txt"

echo "vendor 生成完了:"
du -sh "$vendor"/* | sed "s|$root/||"
