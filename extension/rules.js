// 決定的マスキングルール（LLM 不使用・recall 優先 = 迷ったら塗る）
// SPEC.md「確定事項 1, 2」に基づく。閾値・辞書はここを編集して調整する。
(() => {
  "use strict";

  // これ以上の長さの連続文字列は内容を問わず塗る（見出し等も塗れてよい: recall 優先）
  const LONG_TEXT_THRESHOLD = 8;

  // 塗らずに残してよい UI ラベル語彙。完全一致（正規化後）で判定する。
  // 運用しながら追加する前提の初期辞書。
  const UI_LABEL_ALLOWLIST = new Set([
    // 日本語 UI ラベル
    "保存", "検索", "一覧", "編集", "削除", "新規", "登録", "更新", "追加",
    "戻る", "次へ", "前へ", "閉じる", "開く", "送信", "確認", "確定", "取消",
    "キャンセル", "ログイン", "ログアウト", "設定", "ヘルプ", "メニュー",
    "ホーム", "詳細", "表示", "非表示", "選択", "解除", "絞り込み", "並び替え",
    "出力", "印刷", "複製", "承認", "却下", "申請", "完了", "未完了",
    "新規登録", "新規作成", "詳細表示", "一括操作", "絞り込む",
    "氏名", "名前", "住所", "電話", "電話番号", "番号", "メール",
    "メールアドレス", "アドレス", "顧客", "顧客名", "会社", "会社名",
    "部署", "担当", "担当者", "状態", "日付", "金額", "備考", "操作",
    "件名", "内容", "種別", "区分", "管理", "システム", "画面",
    "ログイン中", "契約",
    // 英語 UI ラベル
    "save", "search", "edit", "delete", "new", "add", "back", "next",
    "close", "open", "submit", "cancel", "login", "logout", "settings",
    "help", "menu", "home", "detail", "details", "list", "view", "select",
    "name", "email", "address", "phone", "status", "date", "amount",
    "action", "actions", "filter", "sort", "export", "print", "note",
  ]);

  // 定型 PII（ブロックリスト）。OCR の単語分割で崩れても部分一致で拾えるよう緩めに書く。
  const BLOCK_PATTERNS = [
    { re: /@/, reason: "at-mark" }, // メールアドレスの断片
    { re: /\d/, reason: "digit" }, // 電話・郵便・金額・日付・ID など数字を含むもの全部
  ];

  // 人名になり得る短い日本語（漢字・かな 1〜4 文字）。アローリストに無ければ塗る。
  const JP_NAME_LIKE = /^[ぁ-ゖァ-ヺー一-鿿々]{1,4}$/;

  // ASCII のみの語。3 文字以下（OK / ID 等）は残し、それ以外はアローリストに無ければ塗る。
  const ASCII_WORD = /^[A-Za-z][A-Za-z.'-]*$/;
  const ASCII_KEEP_MAX_LEN = 3;

  const normalize = (raw) =>
    raw
      .trim()
      // 全角英数字を半角へ寄せてから判定する
      .replace(/[Ａ-Ｚａ-ｚ０-９＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase();

  /**
   * OCR で得た 1 単語を塗るべきか判定する。
   * @param {string} rawText
   * @returns {{mask: boolean, reason: string}}
   */
  function judge(rawText) {
    const text = normalize(rawText);
    if (text.length === 0) return { mask: false, reason: "empty" };

    for (const { re, reason } of BLOCK_PATTERNS) {
      if (re.test(text)) return { mask: true, reason };
    }
    if (text.length >= LONG_TEXT_THRESHOLD) return { mask: true, reason: "long-text" };
    if (UI_LABEL_ALLOWLIST.has(text)) return { mask: false, reason: "allowlist" };
    if (JP_NAME_LIKE.test(rawText.trim())) return { mask: true, reason: "jp-name-like" };
    if (ASCII_WORD.test(text)) {
      return text.length <= ASCII_KEEP_MAX_LEN
        ? { mask: false, reason: "short-ascii" }
        : { mask: true, reason: "ascii-word" };
    }
    // 記号混じり等の判別不能な語は recall 優先で塗る
    return { mask: true, reason: "unknown" };
  }

  /**
   * 形態素解析トークン（kuromoji IPADIC 形式）を塗るべきか判定する。
   * judge() と違い品詞情報を使えるため、辞書登録なしで固有名詞（人名・組織・地名）を
   * 検出できる。単位が言語的に正しい前提なので judge() より精密。
   * @param {{surface_form: string, pos: string, pos_detail_1: string, word_type: string}} token
   * @returns {{mask: boolean, reason: string}}
   */
  function judgeToken(token) {
    const surface = token.surface_form;
    const text = normalize(surface);
    if (text.length === 0) return { mask: false, reason: "empty" };

    for (const { re, reason } of BLOCK_PATTERNS) {
      if (re.test(text)) return { mask: true, reason };
    }
    // 記号のみのトークン（| : - . 等）は罫線・区切りの類なので塗らない
    // （@ や数字は上の BLOCK_PATTERNS が先に拾う）
    if (/^[^\p{L}\p{N}]+$/u.test(text)) return { mask: false, reason: "punct" };
    if (text.length >= LONG_TEXT_THRESHOLD) return { mask: true, reason: "long-text" };
    if (UI_LABEL_ALLOWLIST.has(text)) return { mask: false, reason: "allowlist" };

    if (token.pos === "名詞" && token.pos_detail_1 === "固有名詞") {
      return { mask: true, reason: "proper-noun" };
    }
    if (token.pos === "名詞" && token.pos_detail_1 === "数") {
      return { mask: true, reason: "number" }; // 漢数字等（算用数字は digit で先に落ちる）
    }
    if (token.word_type === "UNKNOWN") {
      // 辞書に無い語は名前・ID・造語の可能性が高いので塗る。ただし記号（罫線等）は残す
      if (token.pos === "記号") return { mask: false, reason: "symbol" };
      return { mask: true, reason: "unknown-token" };
    }
    // 辞書に載っている一般語（一般名詞・動詞・助詞など）は残す
    return { mask: false, reason: `pos:${token.pos}` };
  }

  globalThis.Mask2GeminiRules = { judge, judgeToken, LONG_TEXT_THRESHOLD, UI_LABEL_ALLOWLIST };
})();
