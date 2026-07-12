// ユーザーホワイトリスト（マスクしない語句）: storage.local 入出力とフレーズ照合
// SPEC.md「確定事項 8」: 自動ルールより優先。照合は正規化後の行テキストへの部分一致。
(() => {
  "use strict";

  const STORAGE_KEY = "userAllowlist";

  // 空白（全角含む）を除去し、全角英数字を半角へ寄せ、小文字化する。
  // 「山田 太郎」の登録が OCR 上の「山田」「太郎」の並びにも一致するようにするため。
  const normalizePhrase = (s) =>
    s
      .replace(/[\s　]+/g, "")
      .replace(/[Ａ-Ｚａ-ｚ０-９＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase();

  async function load() {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    return obj[STORAGE_KEY] ?? [];
  }

  async function save(terms) {
    const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
    await chrome.storage.local.set({ [STORAGE_KEY]: uniq });
    return uniq;
  }

  async function add(term) {
    const terms = await load();
    terms.push(term);
    return save(terms);
  }

  /**
   * 1 行分の OCR 単語列に対し、登録フレーズに一致して保護（＝マスク解除）すべき
   * 単語 index の集合を返す。純関数（storage 非依存・テスト可能）。
   *
   * 行内の単語テキストを正規化して連結し、フレーズを部分一致で探す。
   * 一致した文字範囲に 1 文字でも重なる単語は丸ごと保護する
   * （境界が単語の途中でも、解除方向にのみ広がるため安全側）。
   *
   * @param {{text: string}[]} words
   * @param {string[]} phrases
   * @returns {Set<number>}
   */
  function findProtectedWordIndices(words, phrases) {
    const result = new Set();
    const normWords = words.map((w) => normalizePhrase(w.text));
    const joined = normWords.join("");
    if (joined.length === 0) return result;

    // 連結文字列の各文字がどの単語由来かの対応表
    const owner = [];
    normWords.forEach((t, i) => {
      for (let k = 0; k < t.length; k++) owner.push(i);
    });

    for (const raw of phrases) {
      const phrase = normalizePhrase(raw);
      if (!phrase) continue;
      let from = 0;
      for (;;) {
        const at = joined.indexOf(phrase, from);
        if (at === -1) break;
        for (let k = at; k < at + phrase.length; k++) result.add(owner[k]);
        from = at + 1;
      }
    }
    return result;
  }

  globalThis.Mask2GeminiAllowlist = {
    STORAGE_KEY,
    normalizePhrase,
    load,
    save,
    add,
    findProtectedWordIndices,
  };
})();
