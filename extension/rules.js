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
    // Issue #2: 過剰マスク対策として追加した一般的な英語 UI 語彙
    "import", "refresh", "reload", "reset", "apply", "clear", "retry",
    "continue", "skip", "finish", "start", "stop", "pause", "resume",
    "sync", "sync status", "bulk", "bulk actions", "overview", "summary",
    "account overview",
    "dashboard", "report", "reports", "analytics", "last modified",
    "modified", "owner", "role", "owner role", "access", "access level",
    "subscription", "subscription plan", "plan", "download", "upload",
    "archive", "draft", "published", "active", "inactive", "enabled",
    "disabled", "pending", "preview", "duplicate", "copy", "paste",
    "undo", "redo", "loading", "error", "warning", "success", "info",
    "notification", "notifications", "profile", "account", "accounts",
    "user", "users", "admin", "administrator", "history", "recent",
    "favorite", "favorites", "bookmark", "bookmarks", "tag", "tags",
    "category", "categories", "group", "groups", "team", "teams",
    "csv", "pdf",
    // Issue #10: 3文字以下ASCII語の自動救済を廃止した代わりに追加した
    // 実用略語（運用しながら追加する前提。個別の短い人名との衝突は許容する）
    "ok", "id", "no", "fax", "url",
    // Issue #2: カタカナの UI 語彙（英語と混在する語もそのまま塗り漏れないよう
    // フレーズとして併記する。例:「CSVエクスポート」は分割されず1トークンに
    // なりうるため、部分一致ではなく語全体をアローリストに含める）
    "エクスポート", "インポート", "リフレッシュ", "ダッシュボード",
    "csvエクスポート", "csvインポート",
  ]);

  // 定型 PII（ブロックリスト）。OCR の単語分割で崩れても部分一致で拾えるよう緩めに書く。
  const BLOCK_PATTERNS = [
    { re: /@/, reason: "at-mark" }, // メールアドレスの断片
    { re: /\d/, reason: "digit" }, // 電話・郵便・金額・日付・ID など数字を含むもの全部
  ];

  // 人名になり得る短い日本語（漢字・かな 1〜4 文字）。アローリストに無ければ塗る。
  const JP_NAME_LIKE = /^[ぁ-ゖァ-ヺー一-鿿々]{1,4}$/;

  // ASCII のみの語。アローリストに無ければ長さに関わらず塗る（Issue #10）。
  const ASCII_WORD = /^[A-Za-z][A-Za-z.'-]*$/;

  // 住所の行政区画接尾辞（1文字）。kuromoji は「東京都」を固有名詞「東京」+
  // 一般名詞「都」に分割するため、judgeToken() の固有名詞判定だけでは
  // この1文字が住所の途中の塗り漏れとして残ってしまう（Issue #5）。
  // 単体で出現した場合のみ対象（複合語の一部として塗られる場合は影響しない）
  const ADDRESS_SUFFIX = new Set(["都", "道", "府", "県", "市", "区", "町", "村", "郡"]);

  const normalize = (raw) =>
    raw
      .trim()
      // 全角英数字を半角へ寄せてから判定する
      .replace(/[Ａ-Ｚａ-ｚ０-９＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase();

  // OCR の単語/トークン分割でメールアドレスが断片化すると、"@" や桁数を含まない
  // 断片（例: 短いドメイン末尾）が judge()/judgeToken() を単体では通過してしまい
  // 塗り漏れになる。これを防ぐため、行を結合した文字列に対してメール全体の
  // パターンを照合し、一致範囲にかかる全トークンをまとめて塗る。
  const LINE_PATTERNS = [
    { re: /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g, reason: "email" },
  ];

  // フレーズ照合（normalizePhrase）と違い、空白・記号を除去しない。
  // "@" "." はメールアドレスの構文そのものなので除去すると一致しなくなる。
  const normalizeForLineMatch = (raw) =>
    raw
      .replace(/[Ａ-Ｚａ-ｚ０-９＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase();

  /**
   * 1 行分の判定単位列を結合し、LINE_PATTERNS に一致する範囲を検出する。
   * 一致範囲にかかる全 unit の index を reason 付きで返す（マスク追加用）。
   * allowlist.findProtectedWordIndices はマスク解除専用なのでこちらは別関数として設ける。
   *
   * 意図的に unit.confidence を一切参照しない（テキストのみで判定する）。
   * 呼び出し側（mask-decider.js）はこの結果を個別トークンの NOISE_CONFIDENCE
   * フィルタより優先させる設計になっている（Issue #3）。
   * @param {{text: string}[]} units
   * @returns {Map<number, string>} unit index -> reason
   */
  function findLinePatternMaskIndices(units) {
    const result = new Map();
    const normTexts = units.map((u) => normalizeForLineMatch(u.text));
    const joined = normTexts.join("");
    if (joined.length === 0) return result;

    // 連結文字列の各文字がどの unit 由来かの対応表
    const owner = [];
    normTexts.forEach((t, i) => {
      for (let k = 0; k < t.length; k++) owner.push(i);
    });

    for (const { re, reason } of LINE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(joined))) {
        const start = m.index;
        const end = start + m[0].length;
        for (let k = start; k < end && k < owner.length; k++) result.set(owner[k], reason);
        if (m[0].length === 0) re.lastIndex += 1; // ゼロ幅一致時の無限ループ防止
      }
    }
    return result;
  }

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
    // ASCII 語は長さに関わらず塗る。かつては3文字以下（OK/ID/FAX等）を長さだけで
    // 残していたが、"Bob"/"Wei"/"Xi" のような短い人名と区別できないことが判明した
    // （Issue #10: kuromoji 上どちらも同じ POS シグネチャになる）。実用略語は
    // UI_LABEL_ALLOWLIST への個別登録で残す（recall優先、SPEC.md確定事項2）
    if (ASCII_WORD.test(text)) return { mask: true, reason: "ascii-word" };
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
    // 住所の行政区画接尾辞（都道府県市区町村郡）は kuromoji 上「一般名詞」に
    // 分類され、固有名詞判定だけでは拾えない（Issue #5）。単体トークンとして
    // 出現した場合はここで塗る
    if (ADDRESS_SUFFIX.has(surface)) return { mask: true, reason: "address-suffix" };
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

  globalThis.Mask2GeminiRules = {
    judge, judgeToken, findLinePatternMaskIndices, LONG_TEXT_THRESHOLD, UI_LABEL_ALLOWLIST,
  };
})();
