// ページに注入されるテキスト/領域抽出器（Issue #13・SPEC.md タスク10）。
// 収集のみを行い、マスク判定は一切しない（判定は review.js 側の共通パイプライン）。
//
// chrome.scripting.executeScript({ files }) の戻り値（最後に評価された式の値）に
// なるよう、ファイル全体を 1 つの IIFE 式にしている。返す値は structured clone
// 可能なプレーンデータに限ること。
//
// 返す形:
//   {
//     viewport: { w, h },                     // CSS px。review 側で画像pxへの係数を出す
//     lines: [{ blockId, semantic, words }],  // mask-decider の lineToUnits 互換の行。
//                                             // words は常に 1 要素で、symbols に
//                                             // 文字単位の bbox を持つ（OCR の symbol 相当）
//     opaque: [{ x, y, w, h, kind }],         // 中身を読めない領域（丸塗り対象。確定事項10）
//   }
(() => {
  "use strict";

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // これ未満 (CSS px) の img/svg/canvas は装飾アイコンとみなし丸塗りしない。
  // アバター画像（32px〜）は超え、ツールバーアイコン（16〜20px）は除外される想定
  const OPAQUE_MIN_PX = 24;

  // 確定事項11: 要素種別レベルの構造判定。ラベル系 → 残す方向の保護、
  // データ系 → テキスト判定が「残す」でも塗る（review 側でそう扱う）。
  // nav（ナビゲーション/メニュー）を含める理由: サイドバーメニューの機能名
  // （「請求管理」等の辞書に無い語）が未知語として大量マスクされるのを防ぐ。
  // トレードオフとして nav 内にユーザー名が出るUI（アカウントメニュー等）は
  // 残ってしまうため、目視確認ステップ（確定事項3）が拾う前提
  const LABEL_TAGS = new Set(["th", "label", "caption", "legend", "button", "summary",
    "nav", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const DATA_TAGS = new Set(["td", "output"]);
  const LABEL_ROLES = new Set(["button", "columnheader", "rowheader", "heading", "tab",
    "navigation", "menu", "menubar", "menuitem"]);
  const DATA_ROLES = new Set(["cell", "gridcell"]);
  // 中身をテキストとして読めない描画要素（確定事項10）
  const OPAQUE_TAGS = new Set(["img", "canvas", "svg", "video", "picture"]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head"]);

  const lines = [];
  const opaque = [];

  // shadow 境界をまたいで親要素を辿る
  const parentOf = (n) => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const semanticOf = (el) => {
    for (let e = el; e; e = parentOf(e)) {
      const role = e.getAttribute("role");
      if (LABEL_TAGS.has(e.localName) || (role && LABEL_ROLES.has(role))) return "label";
      if (DATA_TAGS.has(e.localName) || (role && DATA_ROLES.has(role))) return "data";
    }
    return null;
  };

  // フレーズ照合（ユーザーホワイトリスト・UIラベル辞書）の結合範囲を決める
  // 「ブロック」。インライン要素で分割されたテキスト（例: 株式会社<b>ABC</b>）を
  // 同じブロックに入れるため、最も近い非インライン祖先を単位にする
  let nextBlockId = 0;
  const blockIds = new Map();
  const blockIdOf = (el) => {
    let block = el;
    for (let e = el; e; e = parentOf(e)) {
      const d = getComputedStyle(e).display;
      if (d && !d.startsWith("inline") && d !== "contents") { block = e; break; }
    }
    if (!blockIds.has(block)) blockIds.set(block, nextBlockId++);
    return blockIds.get(block);
  };

  const outsideViewport = ({ x0, y0, x1, y1 }) => x1 < 0 || y1 < 0 || x0 > vw || y0 > vh;

  const pushLine = (blockId, semantic, chars) => {
    if (!chars.some((c) => c.ch.trim())) return; // 空白だけの行は捨てる
    const bbox = {
      x0: Math.min(...chars.map((c) => c.bbox.x0)),
      y0: Math.min(...chars.map((c) => c.bbox.y0)),
      x1: Math.max(...chars.map((c) => c.bbox.x1)),
      y1: Math.max(...chars.map((c) => c.bbox.y1)),
    };
    lines.push({
      blockId, semantic,
      words: [{
        text: chars.map((c) => c.ch).join(""),
        confidence: 100,
        bbox,
        symbols: chars.map((c) => ({ text: c.ch, bbox: c.bbox })),
      }],
    });
  };

  const collectText = (node, offset) => {
    const parent = node.parentElement;
    if (!parent || !node.data.trim()) return;
    const range = node.ownerDocument.createRange();
    const chars = [];
    for (let i = 0; i < node.data.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width === 0 || r.height === 0) continue; // 折り畳まれた空白等
      const bbox = {
        x0: r.left + offset.x, y0: r.top + offset.y,
        x1: r.right + offset.x, y1: r.bottom + offset.y,
      };
      if (outsideViewport(bbox)) continue;
      chars.push({ ch: node.data[i], bbox });
    }
    if (chars.length === 0) return;
    const semantic = semanticOf(parent);
    const blockId = blockIdOf(parent);
    // 折り返しで複数の視覚行にまたがるテキストノードは行ごとに分ける
    // （トークンの bbox union が行間の無関係な領域を巻き込まないように。
    //   OCR 経路の「行」と同じ粒度になる）
    let cur = [];
    for (const c of chars) {
      const last = cur[cur.length - 1];
      const overlap = last
        ? Math.min(last.bbox.y1, c.bbox.y1) - Math.max(last.bbox.y0, c.bbox.y0)
        : 0;
      if (last && overlap < (c.bbox.y1 - c.bbox.y0) * 0.5) {
        pushLine(blockId, semantic, cur);
        cur = [];
      }
      cur.push(c);
    }
    if (cur.length) pushLine(blockId, semantic, cur);
  };

  // フォーム部品の値はテキストノードにならないため、要素の value を
  // 要素矩形ごと 1 行として拾う（文字単位の bbox は取れないので symbols なし）
  const collectFormValue = (el, offset) => {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (["checkbox", "radio", "hidden", "range", "color", "file", "image"].includes(type)) return;
    // password の値は収集しない（画面には ●●● しか写らないのに生の値を
    // storage.session・判定ログへ載せてしまうため。sensitive-data-exposure 対策）。
    // マスク判定に値は不要で、矩形を data 扱いで塗るためのダミー文字列だけ渡す
    const text = type === "password"
      ? (el.value ? "●●●" : "")
      : el.localName === "select"
        ? [...el.selectedOptions].map((o) => o.label).join(" ")
        : (el.value ?? "");
    if (!text.trim()) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const bbox = {
      x0: r.left + offset.x, y0: r.top + offset.y,
      x1: r.right + offset.x, y1: r.bottom + offset.y,
    };
    if (outsideViewport(bbox)) return;
    lines.push({
      blockId: blockIdOf(el),
      // submit/reset/button の value はボタンのラベル。それ以外はユーザー入力値
      semantic: ["button", "submit", "reset"].includes(type) ? "label" : "data",
      words: [{ text, confidence: 100, bbox, symbols: null }],
    });
  };

  const collectOpaque = (el, offset, kind) => {
    const r = el.getBoundingClientRect();
    if (r.width < OPAQUE_MIN_PX || r.height < OPAQUE_MIN_PX) return;
    const bbox = {
      x0: r.left + offset.x, y0: r.top + offset.y,
      x1: r.right + offset.x, y1: r.bottom + offset.y,
    };
    if (outsideViewport(bbox)) return;
    opaque.push({ x: bbox.x0, y: bbox.y0, w: bbox.x1 - bbox.x0, h: bbox.y1 - bbox.y0, kind });
  };

  // closed shadow root は content script（isolated world）でだけ
  // chrome.dom.openOrClosedShadowRoot で覗ける。E2E 等の通常ページ実行では
  // undefined なので open shadow root のみ辿る
  const shadowRootOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  };

  const visitAll = (nodes, offset) => { for (const n of nodes) visit(n, offset); };

  function visit(node, offset) {
    if (node.nodeType === Node.TEXT_NODE) return collectText(node, offset);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    if (OPAQUE_TAGS.has(tag)) return collectOpaque(el, offset, tag);
    if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") {
      let doc = null;
      try { doc = el.contentDocument; } catch { /* cross-origin */ }
      if (doc?.documentElement) {
        const r = el.getBoundingClientRect();
        visit(doc.documentElement, {
          x: offset.x + r.left + el.clientLeft,
          y: offset.y + r.top + el.clientTop,
        });
      } else {
        collectOpaque(el, offset, "frame"); // 中を読めないフレームは丸塗り対象
      }
      return;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return collectFormValue(el, offset);
    }
    if (tag === "slot") {
      // slot 配下は割り当てられた light DOM ノード（無ければフォールバック内容）
      const assigned = el.assignedNodes();
      return visitAll(assigned.length ? assigned : el.childNodes, offset);
    }
    const shadow = shadowRootOf(el);
    if (shadow) {
      // shadow host の light children は slot 経由で描画されるため、
      // shadow tree 側だけを辿る（slot で拾う）
      return visitAll(shadow.childNodes, offset);
    }
    visitAll(el.childNodes, offset);
  }

  visit(document.documentElement, { x: 0, y: 0 });

  return { viewport: { w: vw, h: vh }, lines, opaque };
})();
