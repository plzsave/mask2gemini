// 確認画面: 撮影画像の表示 → テキスト抽出（DOM 優先・OCR フォールバック）
// → 自動マスク → 手動編集 → コピー/Gemini
(async () => {
  "use strict";

  const { judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
    findUnitMetricIndices } = globalThis.Mask2GeminiRules;
  const { lineToUnits, decideParagraphMasks, reasonColorHue } = globalThis.Mask2GeminiMaskDecider;

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
  // デバッグ表示のON/OFFを保存するキー（chrome.storage.local）
  const DEBUG_MODE_KEY = "debugMaskVisualization";
  // デバッグ表示 UI 自体のオプトイン（Issue #29）。設定画面のエンジニア向け
  // オプションでオンにしたときだけ確認画面に .debug-bar を出す
  const DEBUG_PANEL_KEY = "debugPanelEnabled";
  // ワイヤーフレーム出力（Issue #20・確定事項12）のオプトインを保存するキー
  const WIREFRAME_KEY = "wireframeExportEnabled";

  const statusEl = document.getElementById("status");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const overlayCanvas = document.getElementById("debug-overlay");
  const overlayCtx = overlayCanvas.getContext("2d");
  const debugBar = document.getElementById("debug-bar");
  const debugToggle = document.getElementById("debug-toggle");
  const debugLegend = document.getElementById("debug-legend");
  const btnCopyDecisions = document.getElementById("copy-decisions");
  const btnCopyImage = document.getElementById("copy-image");
  const btnSaveWireframe = document.getElementById("save-wireframe");
  const btnCopyPrompt = document.getElementById("copy-prompt");
  const btnOpenGemini = document.getElementById("open-gemini");

  const setStatus = (text) => { statusEl.textContent = text; };

  // 主導線（①→②→③）のステップ進行表示（Issue #29 案B）。実行済みは .done、
  // 次にやる操作は .next で 1 つだけ強調する。表示だけの状態で保存はしない。
  // 順序は実利用順（画像コピー → Gemini で貼り付け → プロンプトをコピー）。
  // 画像とプロンプトを続けてコピーするとクリップボードが上書きされるため、
  // 「コピー → 貼り付け」を 1 段ずつ挟む並びにしている
  const stepButtons = [btnCopyImage, btnOpenGemini, btnCopyPrompt];
  const stepDone = [false, false, false];
  function renderSteps() {
    const nextIndex = stepDone.indexOf(false);
    stepButtons.forEach((btn, i) => {
      btn.classList.toggle("done", stepDone[i]);
      btn.classList.toggle("next", i === nextIndex && !btn.disabled);
    });
  }
  const completeStep = (i) => { stepDone[i] = true; renderSteps(); };

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // 撮影失敗時の生エラー（background.js が String(e) で保存）を、非エンジニアが
  // 次に何をすればよいか分かる日本語に変換する（Issue #34）。判別できない
  // エラーは null を返し、呼び出し側で汎用メッセージに落とす
  function friendlyCaptureError(raw) {
    const s = String(raw ?? "");
    if (s.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
      return "撮影の間隔が短すぎます。数秒待ってから、もう一度拡張アイコンを押してください。";
    }
    if (/activeTab|permission|cannot access|cannot be scripted|chrome:\/\//i.test(s)) {
      return "このページは撮影できません（Chrome の設定画面・ウェブストアなど）。マスクしたい画面のタブで拡張アイコンを押してください。";
    }
    if (/quota/i.test(s)) {
      return "撮影した画像が大きすぎて保存できませんでした。ブラウザのウィンドウを小さくしてから撮り直してください。";
    }
    return null;
  }

  // ---- 撮影データの取得 ----
  const { capture, captureError, domExtract, domExtractError } =
    await chrome.storage.session.get(["capture", "captureError", "domExtract", "domExtractError"]);
  if (!capture) {
    if (captureError) console.debug("[mask2gemini] 撮影エラー:", captureError);
    setStatus(friendlyCaptureError(captureError)
      ?? "撮影データがありません。対象タブで拡張アイコンを押し直してください。");
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
  overlayCanvas.width = image.naturalWidth;
  overlayCanvas.height = image.naturalHeight;

  // masks: 画像ピクセル座標系 {x, y, w, h, source, reason}
  let masks = [];
  let dragPreview = null;
  // kept: 非マスクトークン {x, y, w, h, reason, text}。デバッグオーバーレイ専用で、
  // #canvas の描画（≒コピーされる画像）には一切関与しない
  let allKept = [];
  // decisions: ブロックごとの判定ログ（「判定ログをコピー」用）。実ページでの
  // 探索テスト時に、DevTools を開かずに塗りすぎ/塗り漏れの原因を分析できるようにする
  const allDecisions = [];
  // 確認画面で解除された自動マスク。「残す」と確定した扱いで、ワイヤーフレーム
  // 出力（確定事項12）ではテキストとして出力する
  const revealedMasks = [];

  function render() {
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = "#000";
    for (const m of masks) ctx.fillRect(m.x, m.y, m.w, m.h);
    if (dragPreview) {
      // Shift+ドラッグ = 範囲内一括解除。追加ドラッグ（黒半透明）と区別できる赤系で示す
      ctx.fillStyle = dragPreview.mode === "bulk-unmask"
        ? "rgba(220, 40, 40, 0.35)"
        : "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(dragPreview.x, dragPreview.y, dragPreview.w, dragPreview.h);
    }
  }
  render();

  // ---- デバッグオーバーレイ（判定reasonの可視化。#canvas とは別レイヤーなので
  // copy-image で出力される画像には混入しない） ----
  const reasonColor = (reason) => `hsl(${reasonColorHue(reason)}, 70%, 55%)`;

  function renderLegend() {
    // reason 別の件数付き凡例（塗:/残: を分けて数える）。実ページでの探索テストで
    // 「何が過剰マスクの主因か」を一目で掴めるようにする
    const counts = new Map();
    const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const m of masks) bump(m.reason);
    for (const k of allKept) bump(k.reason);
    debugLegend.replaceChildren(...[...counts.keys()].sort().map((reason) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      const swatch = document.createElement("i");
      swatch.style.background = reasonColor(reason);
      item.append(swatch, document.createTextNode(`${reason} (${counts.get(reason)})`));
      return item;
    }));
  }

  function renderDebugOverlay() {
    overlayCanvas.classList.toggle("visible", debugToggle.checked);
    btnCopyDecisions.hidden = !debugToggle.checked;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!debugToggle.checked) {
      debugLegend.replaceChildren(); // OFF にしたら凡例も消す
      return;
    }
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([]);
    for (const m of masks) {
      overlayCtx.strokeStyle = reasonColor(m.reason);
      overlayCtx.strokeRect(m.x, m.y, m.w, m.h);
    }
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([3, 2]);
    for (const k of allKept) {
      overlayCtx.strokeStyle = reasonColor(k.reason);
      overlayCtx.strokeRect(k.x, k.y, k.w, k.h);
    }
    overlayCtx.setLineDash([]);
    renderLegend();
  }

  const { [DEBUG_MODE_KEY]: savedDebugMode, [DEBUG_PANEL_KEY]: debugPanelEnabled } =
    await chrome.storage.local.get([DEBUG_MODE_KEY, DEBUG_PANEL_KEY]);
  debugBar.hidden = !debugPanelEnabled;
  // パネル非表示（既定）のときはオーバーレイも常にオフ。保存済みの ON 状態が
  // 設定オフ後に不可視のまま効き続けるのを防ぐ
  debugToggle.checked = Boolean(debugPanelEnabled) && Boolean(savedDebugMode);
  debugToggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ [DEBUG_MODE_KEY]: debugToggle.checked });
    renderDebugOverlay();
  });

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

  // ---- テキスト抽出 → 自動マスク（DOM 優先・OCR フォールバック。確定事項9） ----
  // ユーザーホワイトリスト（自動ルールより優先。行単位のフレーズ照合）
  const userTerms = await globalThis.Mask2GeminiAllowlist.load();
  // 組み込み UI ラベル辞書にも同じフレーズ照合を使う。
  // 分割が語彙と食い違っても（「メール|アドレス」「保|存」）一致させるため
  const labelTerms = [...globalThis.Mask2GeminiRules.UI_LABEL_ALLOWLIST];
  const { findProtectedWordIndices } = globalThis.Mask2GeminiAllowlist;
  const sharedDeps = {
    judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
    findUnitMetricIndices, findProtectedWordIndices,
    userTerms, labelTerms,
    noiseConfidence: NOISE_CONFIDENCE, maskPadding: MASK_PADDING,
  };

  const applyDecided = ({ masks: newMasks, kept, decisions }) => {
    masks.push(...newMasks);
    allKept.push(...kept);
    allDecisions.push(decisions);
    // 塗りすぎ・塗り漏れ調査用。確認画面の DevTools コンソールで確認できる
    console.debug("[mask2gemini]", decisions.join(" | "));
  };

  let route = "OCR";
  // ワイヤーフレーム出力用（DOM 経路のみで設定される）: 画像 px → CSS px の
  // 除数と、dom-extractor の装飾ボックス・アイコン領域（CSS px のまま渡す）
  let wireframeScale = 1;
  let wireframeScaleY = 1;
  let wireframeDecor = [];
  let wireframeIcons = [];
  if (domExtract?.viewport?.w > 0 && domExtract?.viewport?.h > 0) {
    // dom-extractor.js の座標は CSS px。画像 px への係数は「画像サイズ ÷ viewport
    // サイズ」で出す（devicePixelRatio・ページズームをまとめて吸収する）
    const sx = image.naturalWidth / domExtract.viewport.w;
    const sy = image.naturalHeight / domExtract.viewport.h;
    const scaleBbox = ({ x0, y0, x1, y1 }) => ({ x0: x0 * sx, y0: y0 * sy, x1: x1 * sx, y1: y1 * sy });

    // 中身を読めない領域（cross-origin iframe・canvas・img 等）は丸塗り（確定事項10）。
    // text を持たないため、クリック解除してもホワイトリスト登録は提示されない
    for (const o of domExtract.opaque ?? []) {
      masks.push({
        x: o.x * sx, y: o.y * sy, w: o.w * sx, h: o.h * sy,
        source: "auto", reason: `opaque(${o.kind})`,
      });
    }

    if (domExtract.lines?.length) {
      route = "DOM";
      setStatus("マスク位置を計算中…");
      const tokenizer = await tokenizerPromise;
      // フレーズ照合・行結合パターンの結合範囲はブロック（非インライン祖先）単位。
      // OCR 経路の block 結合（Issue #6）に相当し、インライン要素で分割された
      // 語句（株式会社<b>ABC</b> 等）のホワイトリスト照合を通す
      const byBlock = new Map();
      for (const line of domExtract.lines) {
        if (!byBlock.has(line.blockId)) byBlock.set(line.blockId, []);
        byBlock.get(line.blockId).push(line);
      }
      for (const [blockId, blockLines] of byBlock) {
        const units = blockLines.flatMap((line) => lineToUnits({
          semantic: line.semantic,
          words: line.words.map((w) => ({
            text: w.text, confidence: w.confidence,
            bbox: scaleBbox(w.bbox),
            symbols: w.symbols?.map((s) => ({ text: s.text, bbox: scaleBbox(s.bbox) })) ?? null,
          })),
        }, tokenizer));
        const decided = decideParagraphMasks(units, { ...sharedDeps, ocrScale: 1 });
        // ワイヤーフレーム出力の groupIds 用にブロック所属を記録する
        // （画像出力・デバッグ表示には影響しない付加情報）
        for (const m of decided.masks) m.blockId = blockId;
        for (const k of decided.kept) k.blockId = blockId;
        applyDecided(decided);
      }
      wireframeScale = sx;
      wireframeScaleY = sy;
      wireframeDecor = domExtract.decor ?? [];
      wireframeIcons = domExtract.icons ?? [];
    }
  }

  if (route === "OCR") {
    // DOM 抽出が無い/空のときのフォールバック（確定事項9）。撮影対象が
    // chrome:// や PDF 等で注入できなかったケースと、テキストの無いページ
    if (domExtractError) {
      console.debug("[mask2gemini] DOM 抽出不可のため OCR にフォールバック:", domExtractError);
    }
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

      // 認識精度向上のため拡大してから OCR にかける（座標は後で OCR_SCALE で割り戻す）
      const upscaled = document.createElement("canvas");
      upscaled.width = image.naturalWidth * OCR_SCALE;
      upscaled.height = image.naturalHeight * OCR_SCALE;
      upscaled.getContext("2d").drawImage(image, 0, 0, upscaled.width, upscaled.height);

      const { data } = await worker.recognize(upscaled, {}, { blocks: true });

      setStatus("マスク位置を計算中…");
      const tokenizer = await tokenizerPromise;

      for (const block of data.blocks ?? []) {
        // メールアドレス等は、折り返しで視覚的に複数の OCR 行へまたがることがある
        // （例: 狭い列幅で word-break: break-all のように途中改行される）。
        // Tesseract は行だけでなく段落(paragraph)の境界でもこうした折り返しを
        // 分割することがあり（Issue #6）、段落単位の結合では救えないケースが
        // 残ったため、パターン照合・アローリスト照合はブロック(block)全体を
        // 結合して行う。判定単位（unit）自体は元の OCR 行ごとの bbox を保持したまま使う。
        // recall 優先方針（SPEC.md 確定事項2）のもと、結合範囲が広がることで
        // 無関係なテキスト同士が偶然パターンに一致するリスクより、断片の
        // 塗り漏れを防ぐことを優先する
        const units = block.paragraphs.flatMap((para) =>
          para.lines.flatMap((line) => lineToUnits(line, tokenizer)));
        applyDecided(decideParagraphMasks(units, { ...sharedDeps, ocrScale: OCR_SCALE }));
      }
    } finally {
      await worker.terminate();
    }
  }

  render();
  renderDebugOverlay();
  // OCR 経路はベストエフォート（Issue #35。誤読による塗り漏れがあり得る）なので、
  // 目視確認を一段強く促す文言にする
  setStatus(route === "DOM"
    ? `自動マスク ${masks.length} 件（ページ構造を解析）。目視で確認し、過不足を直してください。`
    : `自動マスク ${masks.length} 件（画像から文字認識）。認識漏れが起こりやすい方式のため、個人情報が残っていないか特に丁寧に確認してください。`);

  btnCopyImage.disabled = false;
  btnCopyPrompt.disabled = false;
  btnOpenGemini.disabled = false;
  renderSteps(); // 準備完了時点で ① を「次にやる操作」として強調する

  // ④ ワイヤーフレーム出力（Issue #20・確定事項12）。設定でオンのときだけ表示し、
  // DOM 経路限定（OCR 経路は誤読テキストが編集可能ファイルに固定化されるため
  // 無効表示にして理由を示す）
  const { [WIREFRAME_KEY]: wireframeEnabled } = await chrome.storage.local.get(WIREFRAME_KEY);
  if (wireframeEnabled) {
    btnSaveWireframe.hidden = false;
    if (route === "DOM") {
      btnSaveWireframe.disabled = false;
    } else {
      btnSaveWireframe.title =
        "画像から文字認識（OCR）したページでは使えません。誤読した文字がファイルに残るためです";
    }
  }

  // ---- 手動編集（クリックで解除・ドラッグで追加） ----
  const DRAG_THRESHOLD = 4; // これ以下の移動はクリック扱い

  function toImageCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (canvas.width / rect.width),
      y: (ev.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // 2つの矩形が重なっているか（Shift+ドラッグの一括解除の当たり判定用）
  const rectsOverlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Alt+クリックの列一括解除用（Issue #16 論点1・案b）。テーブルの同一カラムの
  // セルは x 範囲がほぼ揃うことを利用する。「氏名」セルの「姓」「名」のように
  // 同列でもトークン間で x が重ならないマスクがあるため、直接の重なりではなく
  // 重なりの推移的クラスタで列を求める（行ごとの幅広マスクが橋渡しになる）。
  // y は問わない（列全体）。表以外で偶然 x が揃ったマスクも解除されるが、
  // 手動起動の操作なので目視確認の範囲内（不足ならドラッグで塗り直せる）
  const xOverlaps = (a, b) => {
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    return overlap > 0 && overlap >= 0.5 * Math.min(a.w, b.w);
  };
  function collectColumn(seed) {
    const column = new Set([seed]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of masks) {
        if (column.has(o)) continue;
        for (const c of column) {
          if (xOverlaps(o, c)) { column.add(o); grew = true; break; }
        }
      }
    }
    return column;
  }

  let dragStart = null;
  let dragBulkUnmask = false;
  canvas.addEventListener("pointerdown", (ev) => {
    dragStart = toImageCoords(ev);
    dragBulkUnmask = ev.shiftKey;
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
      mode: dragBulkUnmask ? "bulk-unmask" : "add",
    };
    render();
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!dragStart) return;
    const masksBefore = masks.length;
    const cur = toImageCoords(ev);
    const moved = Math.hypot(cur.x - dragStart.x, cur.y - dragStart.y);
    if (moved <= DRAG_THRESHOLD) {
      // クリック: 一番手前（後に追加した）マスクを解除。
      // Alt+クリックは同じ列（x 範囲が揃うマスク）をまとめて解除（Issue #16 論点1・案b。
      // 表の「ステータス」「更新日時」等、非機密の列を 1 クリックで空ける。
      // Shift+ドラッグ同様、ホワイトリスト登録の提示は行わない）
      for (let i = masks.length - 1; i >= 0; i--) {
        const m = masks[i];
        if (cur.x >= m.x && cur.x <= m.x + m.w && cur.y >= m.y && cur.y <= m.y + m.h) {
          if (ev.altKey) {
            const column = collectColumn(m);
            revealedMasks.push(...masks.filter((o) => column.has(o) && o.source === "auto" && o.text));
            masks = masks.filter((o) => !column.has(o));
            registerZone.replaceChildren();
          } else {
            masks.splice(i, 1);
            if (m.source === "auto" && m.text) {
              revealedMasks.push(m); // ワイヤーフレーム出力ではテキストとして残す
              offerAllowlistRegistration(m.text);
            }
          }
          break;
        }
      }
    } else if (dragBulkUnmask) {
      // Shift+ドラッグ: 矩形と重なる自動/手動マスクをまとめて解除
      // （日付が並ぶ表やメールが列挙されたメニュー等、1件ずつのクリックが
      //   煩雑なケースの救済。個別クリックと違いホワイトリスト提示は行わない）
      const removed = masks.filter((m) => rectsOverlap(m, dragPreview));
      masks = masks.filter((m) => !rectsOverlap(m, dragPreview));
      revealedMasks.push(...removed.filter((m) => m.source === "auto" && m.text));
      if (removed.length > 0) registerZone.replaceChildren();
    } else if (dragPreview && dragPreview.w > 2 && dragPreview.h > 2) {
      const { x, y, w, h } = dragPreview;
      masks.push({ x, y, w, h, source: "manual", reason: "manual" });
    }
    dragStart = null;
    dragBulkUnmask = false;
    dragPreview = null;
    // マスクを編集したら、コピー済みの画像（①）は編集前の古い状態になるため
    // ① だけステップ未実行に戻す（②③はマスク編集の影響を受けない）
    if (masks.length !== masksBefore && stepDone[0]) {
      stepDone[0] = false;
      renderSteps();
    }
    render();
    renderDebugOverlay();
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
    completeStep(0);
    setStatus("マスク済み画像をコピーしました。② で Gemini を開き、入力欄に貼り付けてください。");
  });

  btnOpenGemini.addEventListener("click", () => {
    completeStep(1);
    setStatus("Gemini に画像を貼り付けたら、この画面に戻って ③ でプロンプトをコピーしてください。");
    chrome.tabs.create({ url: "https://gemini.google.com/" });
  });

  btnCopyPrompt.addEventListener("click", async () => {
    await navigator.clipboard.writeText(PROMPT_TEMPLATE);
    completeStep(2);
    setStatus("プロンプトをコピーしました。Gemini に貼り付け、要望部分を書き換えて送信してください。");
  });

  // アイコン領域（Issue #23）をマスク済みキャンバスから切り抜く。切り抜き元は
  // 「① 画像をコピー」で出力されるのと同一のマスク適用後ピクセルなので、
  // ここから漏えい面は広がらない（opaque マスクされた領域は黒塗りのまま写る）
  function cropIconsFromMaskedCanvas() {
    return wireframeIcons.map((ic) => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(ic.w * wireframeScale));
      c.height = Math.max(1, Math.round(ic.h * wireframeScaleY));
      c.getContext("2d").drawImage(
        canvas,
        ic.x * wireframeScale, ic.y * wireframeScaleY,
        ic.w * wireframeScale, ic.h * wireframeScaleY,
        0, 0, c.width, c.height,
      );
      return { ...ic, dataURL: c.toDataURL("image/png") };
    });
  }

  // ④ ワイヤーフレーム保存（確定事項12）。確認画面の確定状態（手動編集反映後）を
  // .excalidraw へ変換してローカル保存する。マスクした文字列はファイルに含まれない
  btnSaveWireframe.addEventListener("click", () => {
    render(); // 切り抜きの前に、ドラッグプレビュー等を除いた確定状態を描画する
    const file = globalThis.Mask2GeminiWireframeExporter.buildWireframe({
      masks, kept: allKept, revealed: revealedMasks,
      decor: wireframeDecor, icons: cropIconsFromMaskedCanvas(),
      scale: wireframeScale,
    });
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mask2gemini-wireframe.excalidraw";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("ワイヤーフレームを保存しました（excalidraw.com や VS Code 拡張で編集できます）");
  });

  // デバッグ用: 判定結果一式を JSON でコピー（実ページでの探索テストの分析用）。
  // マスク前のテキストを含むため、貼り付け先は手元のエディタ等に留めること
  btnCopyDecisions.addEventListener("click", async () => {
    const summary = {};
    for (const m of masks) summary[`塗:${m.reason}`] = (summary[`塗:${m.reason}`] ?? 0) + 1;
    for (const k of allKept) summary[`残:${k.reason}`] = (summary[`残:${k.reason}`] ?? 0) + 1;
    const payload = {
      route,
      summary,
      masks: masks.map(({ text, reason, source }) => ({ text, reason, source })),
      kept: allKept.map(({ text, reason }) => ({ text, reason })),
      decisions: allDecisions,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setStatus("判定ログ（JSON）をコピーしました。※マスク前のテキストを含みます");
  });
})().catch((e) => {
  document.getElementById("status").textContent =
    "処理中にエラーが発生しました。対象タブで拡張アイコンを押して撮り直してください。";
  console.error(e);
});
