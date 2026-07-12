// 確認画面: 撮影画像の表示 → OCR → 自動マスク → 手動編集 → コピー/Gemini
(async () => {
  "use strict";

  const { judge, judgeToken } = globalThis.Mask2GeminiRules;

  // 単語 bbox の外側に足す余白 (px)。文字の欠け対策で広めに塗る
  const MASK_PADDING = 3;
  // UI スクリーンショットは文字がまばらなので SPARSE_TEXT を使う
  const PAGE_SEG_MODE = Tesseract.PSM.SPARSE_TEXT;
  // OCR 前に画像を拡大すると認識精度が大きく上がる（tesseract.js 同梱ドキュメント推奨）
  const OCR_SCALE = 2;
  // OCR 信頼度がこの値未満の非データ語はマスクしない。ボタン枠線・罫線が
  // 「巡」「昌」等の文字として誤認識される（confidence ≒ 0。実文字は 90 前後）
  // のを除外するため。数字・@ を含む語は信頼度が低くても塗る（安全側）
  const NOISE_CONFIDENCE = 35;

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

  // ---- 形態素解析器（kuromoji）の読み込み ----
  // OCR の単語分割は日本語の語彙単位と一致しないため、判定は形態素トークン単位で行う。
  // 読み込み失敗時は null を返し、OCR 単語単位の判定にフォールバックする。
  const tokenizerPromise = new Promise((resolve) => {
    try {
      // dicPath は相対パスで渡す。kuromoji は内部で path.join を使うため、
      // chrome-extension:// の絶対 URL を渡すと `//` が潰れて壊れる
      kuromoji.builder({ dicPath: "vendor/kuromoji/dict" }).build((err, tokenizer) => {
        if (err) {
          console.warn("kuromoji の読み込みに失敗。OCR 単語単位で判定します", err);
          resolve(null);
        } else {
          resolve(tokenizer);
        }
      });
    } catch (e) {
      console.warn("kuromoji の初期化に失敗。OCR 単語単位で判定します", e);
      resolve(null);
    }
  });

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

  try {
    await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE });
    setStatus("文字を読み取り中…");

    // 認識精度向上のため拡大してから OCR にかける（座標は後で OCR_SCALE で割り戻す）
    const upscaled = document.createElement("canvas");
    upscaled.width = image.naturalWidth * OCR_SCALE;
    upscaled.height = image.naturalHeight * OCR_SCALE;
    upscaled.getContext("2d").drawImage(image, 0, 0, upscaled.width, upscaled.height);

    const { data } = await worker.recognize(upscaled, {}, { blocks: true });

    setStatus("マスク位置を計算中…");
    const tokenizer = await tokenizerPromise;

    // ユーザーホワイトリスト（自動ルールより優先。行単位のフレーズ照合）
    const userTerms = await globalThis.Mask2GeminiAllowlist.load();
    // 組み込み UI ラベル辞書にも同じフレーズ照合を使う。
    // 分割が語彙と食い違っても（「メール|アドレス」「保|存」）一致させるため
    const labelTerms = [...globalThis.Mask2GeminiRules.UI_LABEL_ALLOWLIST];
    const { findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;

    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const units = lineToUnits(line, tokenizer);
          const userProtected = findProtectedWordIndices(units, userTerms);
          const labelProtected =
            findProtectedWordIndices(units, labelTerms, { fullCoverage: true });
          const decisions = [];
          units.forEach((unit, i) => {
            const decide = (verdict) => decisions.push(`${unit.text}=${verdict}`);
            if (userProtected.has(i)) return decide("残:user"); // ユーザー登録は無条件で勝つ
            const { mask, reason } = unit.token ? judgeToken(unit.token) : judge(unit.text);
            if (!mask) return decide(`残:${reason}`);
            // ラベル辞書による保護は、数字や @ を含む語（データの可能性が高い）には効かせない
            if (labelProtected.has(i) && reason !== "digit" && reason !== "at-mark") {
              return decide("残:label");
            }
            // 信頼度ほぼゼロの非データ語は UI 部品（枠線・罫線）の誤認識なので塗らない
            if (unit.confidence < NOISE_CONFIDENCE && reason !== "digit" && reason !== "at-mark") {
              return decide(`残:noise(${Math.round(unit.confidence)})`);
            }
            decide(`塗:${reason}`);
            const { x0, y0, x1, y1 } = unit.bbox;
            masks.push({
              x: x0 / OCR_SCALE - MASK_PADDING,
              y: y0 / OCR_SCALE - MASK_PADDING,
              w: (x1 - x0) / OCR_SCALE + MASK_PADDING * 2,
              h: (y1 - y0) / OCR_SCALE + MASK_PADDING * 2,
              source: "auto",
              reason,
              text: unit.text,
            });
          });
          // 塗りすぎ・塗り漏れ調査用。確認画面の DevTools コンソールで確認できる
          console.debug("[mask2gemini]", decisions.join(" | "));
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
