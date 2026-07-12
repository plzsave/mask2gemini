// ユーザーホワイトリスト（マスクしない語句）: storage.local 入出力とフレーズ照合
// SPEC.md「確定事項 8」: 自動ルールより優先。照合は正規化後の行テキストへの部分一致。
(() => {
  "use strict";

  const STORAGE_KEY = "userAllowlist";

  // 空白（全角含む）と句読点類を除去し、全角英数字を半角へ寄せ、小文字化する。
  // 「山田 太郎」の登録が OCR 上の「山田」「太郎」の並びにも、
  // 「ログイン中:」のような記号付き断片が「ログイン中」にも一致するようにするため。
  const normalizePhrase = (s) =>
    s
      .replace(/[\s　:：;；,，.。、()（）[\]「」【】]+/g, "")
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
   * 保護の粒度は fullCoverage で切り替える:
   * - false（既定・ユーザー登録向け）: 一致範囲に 1 文字でも重なる単語を保護する。
   *   本人が明示登録した語なので、境界のずれより解除意図を優先する
   * - true（組み込みラベル辞書向け）: 単語の全文字が一致範囲で覆われている場合のみ
   *   保護する。「会社」がデータ中の社名（株式会社◯◯）へ部分一致して
   *   周辺の断片まで解除してしまうのを防ぐ
   *
   * @param {{text: string}[]} words
   * @param {string[]} phrases
   * @param {{fullCoverage?: boolean}} [opts]
   * @returns {Set<number>}
   */
  function findProtectedWordIndices(words, phrases, { fullCoverage = false } = {}) {
    const result = new Set();
    const normWords = words.map((w) => normalizePhrase(w.text));
    const joined = normWords.join("");
    if (joined.length === 0) return result;

    // 連結文字列の各文字がどの単語由来かの対応表
    const owner = [];
    normWords.forEach((t, i) => {
      for (let k = 0; k < t.length; k++) owner.push(i);
    });

    const covered = new Array(joined.length).fill(false);
    for (const raw of phrases) {
      const phrase = normalizePhrase(raw);
      if (!phrase) continue;
      let from = 0;
      for (;;) {
        const at = joined.indexOf(phrase, from);
        if (at === -1) break;
        for (let k = at; k < at + phrase.length; k++) covered[k] = true;
        from = at + 1;
      }
    }

    let pos = 0;
    normWords.forEach((t, i) => {
      const chars = covered.slice(pos, pos + t.length);
      pos += t.length;
      if (t.length === 0) return; // 記号のみの単語は判定不能なので保護しない
      const hit = fullCoverage ? chars.every(Boolean) : chars.some(Boolean);
      if (hit) result.add(i);
    });
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
