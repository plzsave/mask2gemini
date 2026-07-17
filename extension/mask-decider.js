// OCR 結果 → マスク矩形への変換ロジック（DOM/chrome API 非依存の純関数）。
// review.js から呼ばれるほか、node:test でのユニットテスト対象でもある。
(() => {
  "use strict";

  // 1 行分の抽出結果（OCR line または dom-extractor.js の互換 line）を
  // 判定単位の列に変換する。tokenizer があれば行テキストを形態素解析し、
  // 文字 (symbol) の bbox からトークン単位の矩形を組み立てる。
  // 無ければ単語単位のまま返す。DOM 経路は line.semantic（"label"|"data"|null）を
  // 持ち、各 unit にそのまま引き継ぐ（OCR 経路では undefined → null）。
  function lineToUnits(line, tokenizer) {
    const semantic = line.semantic ?? null;
    if (!tokenizer) {
      return line.words.map((w) => ({
        text: w.text, bbox: w.bbox, token: null, confidence: w.confidence, semantic,
      }));
    }
    // 信頼度は word のものを使う（枠線等のノイズは word confidence が 0 になる。
    // symbol の confidence はノイズでも 70 以上になり判別に使えない）
    const symbols = line.words.flatMap((w) =>
      (w.symbols ?? []).map((s) => ({ text: s.text, bbox: s.bbox, wordConfidence: w.confidence })));
    const lineText = symbols.map((s) => s.text).join("");
    if (lineText.length === 0) {
      return line.words.map((w) => ({
        text: w.text, bbox: w.bbox, token: null, confidence: w.confidence, semantic,
      }));
    }
    // 行テキストの文字位置 → symbol index の対応表（symbol が複数文字の場合に備える）
    const owner = [];
    symbols.forEach((s, i) => {
      for (let k = 0; k < s.text.length; k++) owner.push(i);
    });
    const units = [];
    for (const token of tokenizer.tokenize(lineText)) {
      const start = token.word_position - 1; // word_position は 1 始まり
      const end = Math.min(start + token.surface_form.length, owner.length);
      if (start >= end) continue;
      const ss = symbols.slice(owner[start], owner[end - 1] + 1);
      units.push({
        text: token.surface_form,
        token,
        semantic,
        confidence: Math.min(...ss.map((s) => s.wordConfidence)),
        bbox: {
          x0: Math.min(...ss.map((s) => s.bbox.x0)),
          y0: Math.min(...ss.map((s) => s.bbox.y0)),
          x1: Math.max(...ss.map((s) => s.bbox.x1)),
          y1: Math.max(...ss.map((s) => s.bbox.y1)),
        },
      });
    }
    return units;
  }

  /**
   * まとまった判定単位列（1ブロック分など）から、マスクすべき矩形と判定ログを
   * 算出する。関数自体は units の粒度に依存しない。呼び出し側（review.js）が
   * 折り返しで複数の OCR 行/段落にまたがるメールアドレス等を取りこぼさないよう
   * 十分広い範囲（現状はブロック単位。Issue #6）で units を連結して渡す。
   *
   * @param {object[]} units lineToUnits() の出力を連結したもの。unit.semantic
   *   （DOM 経路のみ。"label"|"data"|null）は要素種別レベルの構造判定に使う
   * @param {object} deps
   * @param {(text: string) => {mask: boolean, reason: string}} deps.judge
   * @param {(token: object) => {mask: boolean, reason: string}} deps.judgeToken
   * @param {(units: object[]) => Map<number,string>} deps.findLinePatternMaskIndices
   * @param {(units: object[], phrases: string[], opts?: object) => Set<number>} deps.findProtectedWordIndices
   * @param {string[]} deps.userTerms
   * @param {string[]} deps.labelTerms
   * @param {number} deps.noiseConfidence
   * @param {number} deps.ocrScale
   * @param {number} deps.maskPadding
   * @returns {{ masks: object[], kept: object[], decisions: string[] }}
   */
  function decideParagraphMasks(units, deps) {
    const {
      judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
      findProtectedWordIndices,
      userTerms, labelTerms, noiseConfidence, ocrScale, maskPadding,
    } = deps;

    const userProtected = findProtectedWordIndices(units, userTerms);
    const labelProtected = findProtectedWordIndices(units, labelTerms, { fullCoverage: true });
    // 行結合パターン判定（メール断片・電話等の数字ラン。Issue #1）は units 全体を見て
    // 事前に一括確定させる。個々の unit の confidence は一切参照しない
    // （findLinePatternMaskIndices はテキストのみを見る純粋なパターン照合）。
    // Issue #3: 個別トークンの NOISE_CONFIDENCE フィルタ（後段のループ内）より
    // 必ず先に確定させ、下の isDataLike 判定でそのフィルタを無条件にバイパス
    // させること。低信頼トークンが混ざっていてもパターンとして成立していれば
    // confidence を割り引かずそのまま塗る（SPEC.md 確定事項2: recall優先。
    // 割り引くと OCR が荒れた本物の PII を見逃すリスクが増えるため採用しない）。
    // Issue #1（トークン単位→行単位判定への一般化）は LINE_PATTERNS の拡張
    // （digit-run 追加）として実装済み。今後パターンが増えても、この順序
    // （行結合確定 → confidence フィルタ）は維持すること。
    const linePatternMasked = findLinePatternMaskIndices(units);
    // 漢字名ラン（Issue #10: 王偉・陳建国等、構成漢字が辞書に一般語として載って
    // いて固有名詞判定をすり抜ける人名）。行結合パターンと同型だが優先順位は
    // 大きく異なり、data-like にはしない: ユーザー登録語・ラベル辞書・DOM ラベル・
    // NOISE_CONFIDENCE の保護がすべて勝つ（下のループ内の適用位置を参照）
    const nameRunMasked = findKanjiNameRunIndices
      ? findKanjiNameRunIndices(units) : new Map();

    // マスク矩形（padding込み）・kept矩形（padding無し）共通の座標変換
    const toRect = ({ x0, y0, x1, y1 }, padding) => ({
      x: x0 / ocrScale - padding,
      y: y0 / ocrScale - padding,
      w: (x1 - x0) / ocrScale + padding * 2,
      h: (y1 - y0) / ocrScale + padding * 2,
    });

    const masks = [];
    const kept = [];
    const decisions = [];

    // 行結合パターン（email / digit-run）に一致した unit は、トークンごとに
    // 矩形を置くとトークン間の空白が塗り残る（例: "090 - 1234 - 5678" の
    // スペース部分。桁のまとまりが読み取れてしまう）ため、同一行内で連続する
    // 一致範囲を 1 つの矩形にマージして塗る（Issue #1: マスク単位も行の一致範囲へ）。
    // 折り返しで別の OCR 行に分かれた断片（email-wrap）まで union すると
    // 行間の無関係なテキストを巻き込むので、垂直方向に重なる場合のみ結合する。
    const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
    const runs = [];
    const addToRun = (i, unit, reason) => {
      const last = runs[runs.length - 1];
      if (last && last.end === i - 1 && last.reason === reason && vOverlap(last.bbox, unit.bbox)) {
        last.end = i;
        last.texts.push(unit.text);
        last.bbox = {
          x0: Math.min(last.bbox.x0, unit.bbox.x0),
          y0: Math.min(last.bbox.y0, unit.bbox.y0),
          x1: Math.max(last.bbox.x1, unit.bbox.x1),
          y1: Math.max(last.bbox.y1, unit.bbox.y1),
        };
      } else {
        runs.push({ start: i, end: i, reason, texts: [unit.text], bbox: { ...unit.bbox } });
      }
    };
    units.forEach((unit, i) => {
      // reason を渡すと、非マスクトークンとして kept にも記録する
      // （デバッグオーバーレイ用。マスクした場合は reason 省略で masks 側にのみ積む）
      const decide = (verdict, reason) => {
        decisions.push(`${unit.text}=${verdict}`);
        if (reason !== undefined) {
          kept.push({ ...toRect(unit.bbox, 0), reason, text: unit.text });
        }
      };
      if (userProtected.has(i)) return decide("残:user", "user"); // ユーザー登録は無条件で勝つ
      const linePatternReason = linePatternMasked.get(i);
      const { mask, reason } = linePatternReason
        ? { mask: true, reason: linePatternReason }
        : unit.token ? judgeToken(unit.token) : judge(unit.text);
      if (!mask) {
        // DOM 構造上データ位置にある unit（td・フォーム入力値。確定事項11）は、
        // テキスト面の判定が「残す」でも塗る（recall 優先。UI ラベル語彙と同じ
        // 文字列がデータとして入っているケース等を落とさない）
        if (unit.semantic === "data") {
          decide("塗:dom-data");
          masks.push({ ...toRect(unit.bbox, maskPadding), source: "auto", reason: "dom-data", text: unit.text });
          return;
        }
        // 漢字名ラン（Issue #10）。テキスト判定が「残す」でも、人名らしき連結の
        // 一部なら塗る。ただし digit-run と違い保護をバイパスしない:
        // ラベル位置・ラベル辞書・低信頼ノイズなら塗らない（precision 維持）。
        // ラン内の空白トークンもここを通り、addToRun のマージで隙間ごと塗られる
        const nameRunReason = nameRunMasked.get(i);
        if (nameRunReason && unit.semantic !== "label" && !labelProtected.has(i)
          && unit.confidence >= noiseConfidence) {
          decide(`塗:${nameRunReason}`);
          addToRun(i, unit, nameRunReason);
          return;
        }
        return decide(`残:${reason}`, reason);
      }
      // ラベル辞書・ラベル要素による保護は、数字や @ を含む語・行結合で検出した語・
      // データ位置にある語（データの可能性が高い）には効かせない
      const isDataLike = reason === "digit" || reason === "at-mark"
        || Boolean(linePatternReason) || unit.semantic === "data";
      if (!isDataLike) {
        // DOM 構造上ラベル位置（th/label/caption/ボタン類等。確定事項11）は
        // 辞書に無い見出し語でも残す。ラベル辞書（labelTerms）より判定が確実
        if (unit.semantic === "label") return decide("残:dom-label", "dom-label");
        if (labelProtected.has(i)) return decide("残:label", "label");
      }
      // 信頼度ほぼゼロの非データ語は UI 部品（枠線・罫線）の誤認識なので塗らない。
      // linePatternReason（isDataLike）があるトークンはここを必ず通り抜ける
      // （上のコメント参照。Issue #3で明文化した恒久方針）
      if (unit.confidence < noiseConfidence && !isDataLike) {
        const noiseReason = `noise(${Math.round(unit.confidence)})`;
        return decide(`残:${noiseReason}`, noiseReason);
      }
      decide(`塗:${reason}`);
      if (linePatternReason) {
        addToRun(i, unit, reason);
        return;
      }
      masks.push({ ...toRect(unit.bbox, maskPadding), source: "auto", reason, text: unit.text });
    });
    for (const run of runs) {
      masks.push({
        ...toRect(run.bbox, maskPadding), source: "auto", reason: run.reason,
        text: run.texts.join(""),
      });
    }
    return { masks, kept, decisions };
  }

  // reason 文字列から決定的に色相(0-359)を導出する。デバッグオーバーレイの
  // reason ごとの色分けに使う。noise(23) のような可変部分を含む reason は
  // 括弧以降を無視して正規化し、同じ系列は同じ色になるようにする
  function reasonColorHue(reason) {
    const key = reason.replace(/\(.*\)$/, "");
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
  }

  globalThis.Mask2GeminiMaskDecider = { lineToUnits, decideParagraphMasks, reasonColorHue };
})();
