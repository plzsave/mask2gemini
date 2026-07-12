// 確認画面: 撮影画像の表示 → OCR → 自動マスク → 手動編集 → コピー/Gemini
(async () => {
  "use strict";

  const { judge } = globalThis.Mask2GeminiRules;

  // 単語 bbox の外側に足す余白 (px)。文字の欠け対策で広めに塗る
  const MASK_PADDING = 3;
  // UI スクリーンショットは文字がまばらなので SPARSE_TEXT を使う
  const PAGE_SEG_MODE = Tesseract.PSM.SPARSE_TEXT;

  const statusEl = document.getElementById("status");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const btnCopyImage = document.getElementById("copy-image");
  const btnCopyPrompt = document.getElementById("copy-prompt");
  const btnOpenGemini = document.getElementById("open-gemini");

  const setStatus = (text) => { statusEl.textContent = text; };

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // ---- 撮影データの取得 ----
  const { capture, captureError } = await chrome.storage.session.get(["capture", "captureError"]);
  if (!capture) {
    setStatus(`撮影データがありません。対象タブで拡張アイコンを押し直してください。${captureError ? ` (${captureError})` : ""}`);
    return;
  }

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = capture.dataUrl;
  });
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  // masks: 画像ピクセル座標系 {x, y, w, h, source, reason}
  let masks = [];
  let dragPreview = null;

  function render() {
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = "#000";
    for (const m of masks) ctx.fillRect(m.x, m.y, m.w, m.h);
    if (dragPreview) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(dragPreview.x, dragPreview.y, dragPreview.w, dragPreview.h);
    }
  }
  render();

  // ---- OCR → 自動マスク ----
  setStatus("OCR エンジンを起動中…");
  const vendorUrl = (p) => chrome.runtime.getURL(`vendor/${p}`);
  const worker = await Tesseract.createWorker(["jpn", "eng"], Tesseract.OEM.LSTM_ONLY, {
    workerPath: vendorUrl("tesseract/worker.min.js"),
    corePath: vendorUrl("core"),
    langPath: vendorUrl("lang"),
    workerBlobURL: false, // 拡張ページの CSP (script-src 'self') と整合させる
    gzip: true,
    logger: (m) => {
      if (m.status === "recognizing text") {
        setStatus(`文字を読み取り中… ${Math.round(m.progress * 100)}%`);
      }
    },
  });

  try {
    await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE });
    setStatus("文字を読み取り中…");
    const { data } = await worker.recognize(capture.dataUrl, {}, { blocks: true });

    // ユーザーホワイトリスト（自動ルールより優先。行単位のフレーズ照合）
    const userTerms = await globalThis.Mask2GeminiAllowlist.load();
    // 組み込み UI ラベル辞書にも同じフレーズ照合を使う。
    // OCR が「メール|アドレス」「保|存」のように語彙と違う単位に分割しても一致させるため
    const labelTerms = [...globalThis.Mask2GeminiRules.UI_LABEL_ALLOWLIST];
    const { findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;

    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const userProtected = findProtectedWordIndices(line.words, userTerms);
          const labelProtected =
            findProtectedWordIndices(line.words, labelTerms, { fullCoverage: true });
          line.words.forEach((word, i) => {
            if (userProtected.has(i)) return; // ユーザー登録は無条件で勝つ
            const { mask, reason } = judge(word.text);
            if (!mask) return;
            // ラベル辞書による保護は、数字や @ を含む語（データの可能性が高い）には効かせない
            if (labelProtected.has(i) && reason !== "digit" && reason !== "at-mark") return;
            const { x0, y0, x1, y1 } = word.bbox;
            masks.push({
              x: x0 - MASK_PADDING,
              y: y0 - MASK_PADDING,
              w: x1 - x0 + MASK_PADDING * 2,
              h: y1 - y0 + MASK_PADDING * 2,
              source: "auto",
              reason,
              text: word.text,
            });
          });
        }
      }
    }
    render();
    setStatus(`自動マスク ${masks.length} 件。目視で確認し、過不足を直してください。`);
  } finally {
    await worker.terminate();
  }

  btnCopyImage.disabled = false;
  btnCopyPrompt.disabled = false;
  btnOpenGemini.disabled = false;

  // ---- 手動編集（クリックで解除・ドラッグで追加） ----
  const DRAG_THRESHOLD = 4; // これ以下の移動はクリック扱い

  function toImageCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (canvas.width / rect.width),
      y: (ev.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  let dragStart = null;
  canvas.addEventListener("pointerdown", (ev) => {
    dragStart = toImageCoords(ev);
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragStart) return;
    const cur = toImageCoords(ev);
    dragPreview = {
      x: Math.min(dragStart.x, cur.x),
      y: Math.min(dragStart.y, cur.y),
      w: Math.abs(cur.x - dragStart.x),
      h: Math.abs(cur.y - dragStart.y),
    };
    render();
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!dragStart) return;
    const cur = toImageCoords(ev);
    const moved = Math.hypot(cur.x - dragStart.x, cur.y - dragStart.y);
    if (moved <= DRAG_THRESHOLD) {
      // クリック: 一番手前（後に追加した）マスクを解除
      for (let i = masks.length - 1; i >= 0; i--) {
        const m = masks[i];
        if (cur.x >= m.x && cur.x <= m.x + m.w && cur.y >= m.y && cur.y <= m.y + m.h) {
          masks.splice(i, 1);
          if (m.source === "auto" && m.text) offerAllowlistRegistration(m.text);
          break;
        }
      }
    } else if (dragPreview && dragPreview.w > 2 && dragPreview.h > 2) {
      masks.push({ ...dragPreview, source: "manual", reason: "manual" });
    }
    dragStart = null;
    dragPreview = null;
    render();
    setStatus(`マスク ${masks.length} 件`);
  });

  // ---- ホワイトリスト登録導線（自動マスクの解除時に提示） ----
  const registerZone = document.getElementById("register-zone");
  function offerAllowlistRegistration(text) {
    const btn = document.createElement("button");
    btn.textContent = `「${text}」を次回からマスクしない`;
    btn.addEventListener("click", async () => {
      await globalThis.Mask2GeminiAllowlist.add(text);
      registerZone.replaceChildren();
      setStatus(`「${text}」をホワイトリストに登録しました（設定画面で編集できます）`);
    });
    registerZone.replaceChildren(btn); // 提示は常に最新の 1 件だけ
  }

  // ---- 出力 ----
  const PROMPT_TEMPLATE = [
    "添付したのは、いま使っているアプリの画面のスクリーンショットです。",
    "秘匿情報は黒塗りにしてあります。黒塗り部分は適当なダミーデータで置き換えて構いません。",
    "",
    "お客様から次のような要望をもらいました。",
    "「（ここに顧客要望をなるべく原文のまま書く）」",
    "",
    "この要望を反映した「改善後のイメージ画面」を、HTML のモックとして作ってください。",
    "条件:",
    "- 元のスクリーンショットの配色・雰囲気になるべく合わせてください",
    "- 変更した箇所がどこか、あとで説明できるようにしてください",
    "- 実際に動く必要はありません。見た目のイメージが伝われば十分です",
  ].join("\n");

  btnCopyImage.addEventListener("click", async () => {
    render(); // ドラッグプレビュー等を除いた確定状態で出力
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("マスク済み画像をコピーしました。Gemini の入力欄に貼り付けてください。");
  });

  btnCopyPrompt.addEventListener("click", async () => {
    await navigator.clipboard.writeText(PROMPT_TEMPLATE);
    setStatus("プロンプトをコピーしました。要望部分を書き換えて使ってください。");
  });

  btnOpenGemini.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://gemini.google.com/" });
  });
})().catch((e) => {
  document.getElementById("status").textContent = `エラー: ${e?.message ?? e}`;
  console.error(e);
});
