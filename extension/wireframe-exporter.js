// エンジニア向け出力アダプタ（Issue #20・確定事項12）: 確認画面の確定状態
// （マスク・残存テキスト・装飾抽出）→ .excalidraw (JSON) への決定的変換。
// DOM/chrome API 非依存の純関数で、review.js と node:test の両方から呼ばれる。
//
// 設計上の制約（確定事項12）:
// - 塗る判定・手動マスクの文字列は出力に一切含めない（ハッチ矩形のみ）
// - 決定的変換とする（乱数 seed・タイムスタンプを含めない。同入力→同出力）
// - fontFamily 等、上流仕様を確認していないプロパティは書かない。
//   Excalidraw 側の読み込み（restore()）が欠損プロパティをデフォルト補完する
//
// customData（意味のメタデータ層）:
// 抽出由来の全要素に customData.m2g を刻む（Excalidraw 公式サポートの
// 任意メタデータ。レンダリング・編集に影響せず保存される）。cc-sdd 等で
// LLM が JSON を読む際に「何の枠か」を機械可読にするため。
// - role: "masked"（+ reason=判定種別。文字列そのものではないので漏えいなし）
//         / "text"（残存 UI テキスト） / "revealed"（確認画面で解除された語）
//         / "decor"（装飾） / "icon"（+ kind）
// - kind: DOM の要素種別（th/td/label/nav/h1/button/input:text 等。Issue #48）。
//         dom-extractor が semantic 判定時に見た種別の透過で、取れたときだけ載る。
//         タグ名・type 属性であって内容ではないため漏えい面は増えない
// - customData が**無い**要素 = エンジニアが Excalidraw で後から追加した提案部分、
//   という読み分けを README に定めている（Excalidraw の複製操作は customData ごと
//   コピーするため、既存のデータ枠を複製して増やす編集なら意味も追従する）
(() => {
  "use strict";

  // マスク矩形の塗り。黒塗りではなくハッチにするのは「ここに何か入る」という
  // ワイヤーフレームの記法に寄せるため（中身が読めない点は黒塗りと同じ）
  const MASK_FILL = { fillStyle: "hachure", backgroundColor: "#ced4da", strokeColor: "#868e96" };
  // 読めない領域（iframe/canvas/img 由来）はマスクと塗り分ける
  const OPAQUE_FILL = { fillStyle: "cross-hatch", backgroundColor: "#dee2e6", strokeColor: "#868e96" };
  // Excalidraw の text 要素の既定 lineHeight（bbox 高さ → fontSize の換算に使う）
  const LINE_HEIGHT = 1.25;
  const MIN_FONT_SIZE = 9;
  // 同一行内でこの比率 × 行高さ以下の水平ギャップなら 1 テキスト要素にマージする
  const MERGE_GAP_RATIO = 0.6;
  // マージ時、この比率 × 行高さ以上のギャップには空白を 1 つ入れる
  const SPACE_GAP_RATIO = 0.15;

  const round = (v) => Math.round(v * 100) / 100;

  /**
   * kept（残存テキスト）を視覚行ごとにまとめ、行内で近接する断片を 1 テキストに
   * マージする。トークン単位のままだと Excalidraw 上の編集単位が細かすぎるため。
   * @param {{x:number,y:number,w:number,h:number,text:string,blockId?:number}[]} kept
   * @returns {{x:number,y:number,w:number,h:number,text:string,blockId?:number}[]}
   */
  function mergeTextRuns(kept) {
    const sorted = [...kept].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const merged = [];
    for (const k of sorted) {
      const last = merged[merged.length - 1];
      const vOverlap = last
        ? Math.min(last.y + last.h, k.y + k.h) - Math.max(last.y, k.y)
        : 0;
      const lineH = Math.max(k.h, last?.h ?? 0);
      const gap = last ? k.x - (last.x + last.w) : Infinity;
      if (last && last.blockId === k.blockId
        && vOverlap > lineH * 0.5 && gap <= lineH * MERGE_GAP_RATIO) {
        if (gap >= lineH * SPACE_GAP_RATIO) last.text += " ";
        last.text += k.text;
        // 要素種別（kind。Issue #48）はマージ範囲で一致する場合のみ残す
        // （同一ブロック内で th と平文が混ざる等、確信が持てなければ出さない）
        if (last.kind !== k.kind) last.kind = null;
        const x1 = Math.max(last.x + last.w, k.x + k.w);
        const y1 = Math.max(last.y + last.h, k.y + k.h);
        last.x = Math.min(last.x, k.x);
        last.y = Math.min(last.y, k.y);
        last.w = x1 - last.x;
        last.h = y1 - last.y;
      } else {
        merged.push({ ...k });
      }
    }
    return merged;
  }

  /**
   * .excalidraw ファイル（JSON.stringify 可能なオブジェクト）を組み立てる。
   * 座標は scale で割って CSS px に正規化する（decor は抽出時から CSS px なので割らない）。
   *
   * @param {object} input
   * @param {object[]} input.masks   確定状態のマスク矩形（画像 px）。text は参照しない
   * @param {object[]} input.kept    残存テキスト（画像 px・text 付き）
   * @param {object[]} [input.revealed] 確認画面で解除された自動マスク（画像 px・text 付き）。
   *   ユーザーが「残す」と確定した扱いでテキストとして出力する
   * @param {object[]} [input.decor] dom-extractor の装飾ボックス（CSS px）
   * @param {object[]} [input.icons] アイコン領域（Issue #23）。CSS px の bbox に加え、
   *   review.js がマスク済みキャンバスから切り抜いた dataURL（image/png）を持つ。
   *   切り抜き元は「① 画像をコピー」と同一のマスク適用後ピクセルなので、
   *   ここから漏えい面は広がらない（確定事項12 の派生）
   * @param {number} [input.scale]   画像 px → CSS px の除数（既定 1）
   * @returns {object} .excalidraw ファイル内容
   */
  function buildWireframe({ masks, kept, revealed = [], decor = [], icons = [], scale = 1 }) {
    let n = 0;
    const nextId = (prefix) => `m2g-${prefix}-${(n++).toString(36).padStart(4, "0")}`;
    const groupIds = (blockId) => (blockId === undefined ? [] : [`block-${blockId}`]);
    const elements = [];

    // 最背面: 装飾ボックス（実際の色を持ち込む。カード・バー・罫線）
    for (const d of decor) {
      elements.push({
        id: nextId("d"), type: "rectangle",
        x: round(d.x), y: round(d.y), width: round(d.w), height: round(d.h),
        fillStyle: "solid",
        backgroundColor: d.bg ? d.color : "transparent",
        strokeColor: d.border ? d.color : "transparent",
        strokeWidth: 1, roughness: 1, groupIds: [],
        customData: { m2g: { role: "decor" } },
      });
    }

    // 装飾の上・テキストの下: アイコン（マスク済みキャンバスからの切り抜き）。
    // files の created/lastRetrieved は決定性のため固定値 0 にする（確定事項12）
    const files = {};
    for (const ic of icons) {
      if (!ic.dataURL) continue; // 切り抜きに失敗した領域は出力しない
      const fileId = nextId("f");
      files[fileId] = {
        mimeType: "image/png", id: fileId, dataURL: ic.dataURL,
        created: 0, lastRetrieved: 0,
      };
      elements.push({
        id: nextId("i"), type: "image",
        x: round(ic.x), y: round(ic.y), width: round(ic.w), height: round(ic.h),
        fileId, status: "saved", scale: [1, 1],
        strokeColor: "transparent", groupIds: [],
        customData: { m2g: { role: "icon", kind: ic.kind } },
      });
    }

    // テキスト（残存 + 解除済みマスク）。解除済みはマージ対象にしない
    // （マスク矩形単位ですでにまとまっているため）
    // kind（DOM の要素種別。th/td/nav/input:text 等。Issue #48）は取れたときだけ
    // m2g に載せる（OCR 由来や種別なしの平文には無い）
    const withKind = (m2g, kind) => (kind ? { ...m2g, kind } : m2g);
    const textItems = [
      ...mergeTextRuns(kept).map((t) => ({ ...t, m2g: withKind({ role: "text" }, t.kind) })),
      ...revealed.filter((m) => m.text)
        .map((m) => ({ ...m, m2g: withKind({ role: "revealed", reason: m.reason }, m.kind) })),
    ];
    for (const t of textItems) {
      const x = t.x / scale, y = t.y / scale, w = t.w / scale, h = t.h / scale;
      elements.push({
        id: nextId("t"), type: "text",
        x: round(x), y: round(y), width: round(w), height: round(h),
        text: t.text, originalText: t.text,
        fontSize: Math.max(MIN_FONT_SIZE, Math.round(h / LINE_HEIGHT)),
        textAlign: "left", verticalAlign: "top",
        strokeColor: "#1e1e1e", groupIds: groupIds(t.blockId),
        customData: { m2g: t.m2g },
      });
    }

    // 最前面: マスク矩形（文字列は書かない。確定事項12）
    for (const m of masks) {
      const fill = String(m.reason ?? "").startsWith("opaque") ? OPAQUE_FILL : MASK_FILL;
      elements.push({
        id: nextId("m"), type: "rectangle",
        x: round(m.x / scale), y: round(m.y / scale),
        width: round(m.w / scale), height: round(m.h / scale),
        ...fill, strokeWidth: 1, roughness: 1, groupIds: groupIds(m.blockId),
        // reason は判定種別（digit-run / proper-noun / dom-data 等）であって
        // マスクした文字列ではない。kind（td/input:email 等）と合わせて
        // 「何のダミーを入れる枠か」を LLM に伝える
        customData: { m2g: withKind({ role: "masked", reason: m.reason ?? "manual" }, m.kind) },
      });
    }

    return {
      type: "excalidraw",
      version: 2,
      source: "mask2gemini",
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files,
    };
  }

  globalThis.Mask2GeminiWireframeExporter = { buildWireframe, mergeTextRuns };
})();
