// OCR 結果 → マスク矩形への変換ロジック（DOM/chrome API 非依存の純関数）。
// review.js から呼ばれるほか、node:test でのユニットテスト対象でもある。
(() => {
  "use strict";

  // 1 行分の OCR 結果を判定単位の列に変換する。
  // tokenizer があれば行テキストを形態素解析し、文字 (symbol) の bbox から
  // トークン単位の矩形を組み立てる。無ければ OCR の単語単位のまま返す。
  function lineToUnits(line, tokenizer) {
    if (!tokenizer) {
      return line.words.map((w) => ({
        text: w.text, bbox: w.bbox, token: null, confidence: w.confidence,
      }));
    }
    // 信頼度は word のものを使う（枠線等のノイズは word confidence が 0 になる。
    // symbol の confidence はノイズでも 70 以上になり判別に使えない）
    const symbols = line.words.flatMap((w) =>
      (w.symbols ?? []).map((s) => ({ text: s.text, bbox: s.bbox, wordConfidence: w.confidence })));
    const lineText = symbols.map((s) => s.text).join("");
    if (lineText.length === 0) {
      return line.words.map((w) => ({
        text: w.text, bbox: w.bbox, token: null, confidence: w.confidence,
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
   * @param {object[]} units lineToUnits() の出力を連結したもの
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
   * @returns {{ masks: object[], decisions: string[] }}
   */
  function decideParagraphMasks(units, deps) {
    const {
      judge, judgeToken, findLinePatternMaskIndices, findProtectedWordIndices,
      userTerms, labelTerms, noiseConfidence, ocrScale, maskPadding,
    } = deps;

    const userProtected = findProtectedWordIndices(units, userTerms);
    const labelProtected = findProtectedWordIndices(units, labelTerms, { fullCoverage: true });
    const linePatternMasked = findLinePatternMaskIndices(units);

    const masks = [];
    const decisions = [];
    units.forEach((unit, i) => {
      const decide = (verdict) => decisions.push(`${unit.text}=${verdict}`);
      if (userProtected.has(i)) return decide("残:user"); // ユーザー登録は無条件で勝つ
      const linePatternReason = linePatternMasked.get(i);
      const { mask, reason } = linePatternReason
        ? { mask: true, reason: linePatternReason }
        : unit.token ? judgeToken(unit.token) : judge(unit.text);
      if (!mask) return decide(`残:${reason}`);
      // ラベル辞書による保護は、数字や @ を含む語・行結合で検出した語
      // （データの可能性が高い）には効かせない
      const isDataLike = reason === "digit" || reason === "at-mark" || Boolean(linePatternReason);
      if (labelProtected.has(i) && !isDataLike) {
        return decide("残:label");
      }
      // 信頼度ほぼゼロの非データ語は UI 部品（枠線・罫線）の誤認識なので塗らない
      if (unit.confidence < noiseConfidence && !isDataLike) {
        return decide(`残:noise(${Math.round(unit.confidence)})`);
      }
      decide(`塗:${reason}`);
      const { x0, y0, x1, y1 } = unit.bbox;
      masks.push({
        x: x0 / ocrScale - maskPadding,
        y: y0 / ocrScale - maskPadding,
        w: (x1 - x0) / ocrScale + maskPadding * 2,
        h: (y1 - y0) / ocrScale + maskPadding * 2,
        source: "auto",
        reason,
        text: unit.text,
      });
    });
    return { masks, decisions };
  }

  globalThis.Mask2GeminiMaskDecider = { lineToUnits, decideParagraphMasks };
})();
