// 設定画面: ホワイトリストの追加・削除・JSON エクスポート/インポート
(async () => {
  "use strict";

  const { load, save } = globalThis.Mask2GeminiAllowlist;

  const listEl = document.getElementById("list");
  const form = document.getElementById("add-form");
  const termInput = document.getElementById("term");
  const msgEl = document.getElementById("msg");

  let terms = await load();

  const setMsg = (text) => { msgEl.textContent = text; };

  function render() {
    listEl.replaceChildren();
    if (terms.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "まだ登録がありません";
      listEl.append(li);
      return;
    }
    terms.forEach((term, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = term;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "削除";
      del.addEventListener("click", async () => {
        terms.splice(i, 1);
        terms = await save(terms);
        render();
        setMsg(`「${term}」を削除しました`);
      });
      li.append(span, del);
      listEl.append(li);
    });
  }
  render();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const term = termInput.value.trim();
    if (!term) return;
    terms.push(term);
    terms = await save(terms);
    termInput.value = "";
    render();
    setMsg(`「${term}」を追加しました`);
  });

  document.getElementById("export").addEventListener("click", () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, terms }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mask2gemini-allowlist.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg(`${terms.length} 件をエクスポートしました`);
  });

  document.getElementById("import").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = Array.isArray(parsed) ? parsed : parsed?.terms;
      if (!Array.isArray(imported) || !imported.every((t) => typeof t === "string")) {
        throw new Error("形式が不正です（文字列の配列、または {terms: [...]} を想定）");
      }
      const before = terms.length;
      terms = await save([...terms, ...imported]);
      render();
      setMsg(`インポート完了: ${terms.length - before} 件を追加（重複は除外）`);
    } catch (e) {
      setMsg(`インポート失敗: ${e.message}`);
    } finally {
      ev.target.value = "";
    }
  });
})();
