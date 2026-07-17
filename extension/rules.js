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
    // Issue #7: IPADIC が固有名詞扱いする一般的なカタカナ UI 語彙
    // （「月間アクティブユーザー」等のダッシュボード指標ラベルで頻出）
    "アクティブ",
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

  // 行結合パターン照合（Issue #1: トークン単位判定の行単位への一般化）。
  // OCR/形態素のトークン分割で PII が断片化すると、単体では無害に見える断片
  // （短いドメイン末尾、電話番号の区切り記号 "-" "(" 等）が judge()/judgeToken()
  // を通過して塗り漏れになる。これを防ぐため、行（実際にはブロック）を結合した
  // 文字列に対してパターンを照合し、一致範囲にかかる全トークンをまとめて塗る。
  // 「単体では怪しくないが行全体の文脈では怪しい」断片はここにパターンを足す。
  const LINE_PATTERNS = [
    // Issue #6: 折り返しで分断されたメールの断片。狭いカード内で折り返された
    // メールは Tesseract が行・段落だけでなく block 境界でも分離することがあり、
    // 結合スコープをいくら広げても「@ より前だけの行」「@ から始まる行」が
    // 単独で現れる。単体では下の email 正規表現に一致しないため、断片の形
    // そのものをパターン化して塗る（recall 優先。区切りの . _ + - ごと
    // 1 ランとして塗り、ドット等の塗り残しも防ぐ）:
    // - ドメイン断片: @ で始まりドット区切りが続く形
    // - ローカルパート断片: ASCII セグメントが . _ % + - で 3 つ以上連結した形
    //   （2 セグメント（error_code 等の UI 語）まで対象にすると、ラベル保護を
    //     バイパスする data-like 扱いが一般語に及び過剰マスクが増えるため 3 以上）
    // email より先に置く: 一致範囲が重なった場合は後勝ちで、完全な email の
    // reason が断片より優先されるように
    // ローカルパート断片は行末の @（折り返し直前に付く）まで含めて 1 ランに
    // する: @ を単独の at-mark 矩形に分けると、ラン矩形との間に細い塗り残しの
    // 隙間ができ、E2E の輝度検査がぎりぎり落ちる程度に地の色が残る
    { re: /@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g, reason: "email-frag" },
    { re: /[a-z0-9]+(?:[._%+-][a-z0-9]+){2,}@?/g, reason: "email-frag" },
    { re: /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g, reason: "email" },
    // 数字を2個以上含み、間が区切り文字だけで繋がる最大ラン（電話・郵便・日付・
    // 金額・ID 等の総称。中身は問わない: recall 優先）。区切りトークン（- ( ) / 等）
    // が punct として塗り残るのを防ぐため、ラン全体を1一致として塗る。
    // 単独数字はトークン側の digit ルールが塗るのでここでは対象外（隣接語の
    // 巻き込みを最小化）。全角の区切り（－ ー （） 等）は normalizeForLineMatch が
    // 半角化しないため文字クラス側に併記する。
    { re: /[〒(（+＋]?\d[\d\-‐‑–—−ー－()（）.,／．，/+#]*\d[)）]?/g, reason: "digit-run" },
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

  // Issue #7: 数字+単位の隣接判定（ダッシュボード指標の過剰マスク緩和）。
  // digit / digit-run ルールに対する唯一の「残す」側の例外で、
  // 「単位らしき文字列が数字に直接くっついている」ケースだけを救済する。
  //
  // recall 優先（SPEC.md 確定事項2）を崩さないための限定条件:
  // - 単位リストは意図的に狭い。円/¥/$（金額）・年/月/日（日付・生年月日）は
  //   PII 性が高いので含めない。h・単独 s も含めない（"24h" 等は塗られたまま）
  // - 数字部は「3桁以下 or カンマ桁区切り」+ 小数のみ。電話・郵便・ID のような
  //   区切り記号（- / 等）を含む形や 4 桁以上の生数字は一致しない
  // - 直前が数字・digit-run の連結記号・@・: の場合は一致させない
  //   （ブロック結合で前の数値と文字列上癒着したケース、時刻 "14:30" の断片、
  //   メールドメイン中の数字列を誤って救済しないため）
  // - 単位の直後に英数字・かな漢字が続く場合は一致しない（"5件数" の "件" 等、
  //   複合語の一部を単位と誤認しないため）
  const UNIT_METRIC_RE = new RegExp(
    "(?<![\\d.,\\-‐‑–—−ー－()（）．，／/+＋#:：〒@])"
    + "[+\\-±−＋－]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?"
    + "(?:%|％|ms|件|人|回|分|秒)"
    + "(?![\\p{L}\\p{N}])",
    "gu",
  );

  /**
   * 数字+単位が直接隣接した指標値（99.95% / 182ms / +12件 等）に属する unit の
   * index を検出する。findLinePatternMaskIndices と同じ行結合方式だが、
   * こちらは「残す」側の例外なので、条件はすべて安全側（狭い側）に倒す:
   * - ブロック結合された units を bbox の縦重なりで視覚行ごとに区切ってから照合する
   *   （別の行の数値と癒着した文字列を「隣接」と誤認しない）
   * - unit の全文字が一致範囲に含まれる場合のみ対象にする（部分一致トークンは
   *   塗られたまま）
   * @param {{text: string, bbox: {y0:number,y1:number}}[]} units
   * @returns {Set<number>} 救済対象の unit index
   */
  function findUnitMetricIndices(units) {
    const result = new Set();
    // bbox を持たない unit（ユニットテストの簡易 unit 等）は行分割の判定材料に
    // ならないだけで、同一行として扱う
    const sameLine = (a, b) =>
      !a || !b || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
    const segments = [];
    units.forEach((u, i) => {
      const last = segments[segments.length - 1];
      if (last && sameLine(units[last[last.length - 1]].bbox, u.bbox)) last.push(i);
      else segments.push([i]);
    });
    for (const seg of segments) {
      const normTexts = seg.map((i) => normalizeForLineMatch(units[i].text));
      const joined = normTexts.join("");
      if (joined.length === 0) continue;
      const owner = [];
      normTexts.forEach((t, k) => {
        for (let c = 0; c < t.length; c++) owner.push(seg[k]);
      });
      const covered = new Array(joined.length).fill(false);
      UNIT_METRIC_RE.lastIndex = 0;
      let m;
      while ((m = UNIT_METRIC_RE.exec(joined))) {
        for (let k = m.index; k < m.index + m[0].length; k++) covered[k] = true;
        if (m[0].length === 0) UNIT_METRIC_RE.lastIndex += 1;
      }
      const fullyCovered = new Map(); // unit index -> 全文字が一致範囲内か
      covered.forEach((cov, k) => {
        const i = owner[k];
        fullyCovered.set(i, (fullyCovered.get(i) ?? true) && cov);
      });
      for (const [i, ok] of fullyCovered) if (ok) result.add(i);
    }
    return result;
  }

  // Issue #10 事象1: 中国人名等の漢字表記は、構成漢字が IPADIC に一般語として
  // 載っているため judgeToken の固有名詞判定をすり抜ける（例: 王偉 → 王=名詞・一般、
  // 偉=形容詞・自立）。単体トークンでは人名と一般語を区別できないため、
  // 「短い漢字トークンの連結」という文脈で判定する（#1 の行結合と同じ思想）。
  //
  // ラン成立条件（すべて AND）:
  // - メンバー: 漢字のみのトークンで、品詞が名詞（一般・固有名詞・サ変接続）
  //   または形容詞（自立）。接尾辞・接頭詞・非自立・数はメンバーにならず
  //   ランを切る（承認+者、東京+都、第+二 等の複合語を巻き込まないため）
  // - 空白トークン（記号/空白）はランを切らないが漢字数には数えない。
  //   「王 偉」「山田 太郎」の姓名間スペース対応（kuromoji は半角/全角とも
  //   空白を独立トークンにする）。OCR 経路は行結合時にスペースが消えるため
  //   「王偉」形で来る。両形とも同じランとして扱う
  // - メンバー 2 トークン以上、漢字合計 2〜4 文字（人名の典型長。5 文字以上の
  //   連結は複合名詞の可能性が高いので対象外）
  // - アンカー: 1 文字漢字メンバーまたは固有名詞メンバーを 1 つ以上含む
  //   （顧客+管理のような 2字+2字 の一般語複合を除外する）
  //
  // digit-run と違い data-like ではない: ユーザー登録語・ラベル辞書・DOM ラベル
  // 要素・NOISE_CONFIDENCE の保護がすべて勝つ（precision 維持。mask-decider 側）
  const KANJI_RUN_MEMBER = /^[一-鿿々]+$/;
  const KANJI_RUN_MIN = 2;
  const KANJI_RUN_MAX = 4;
  const KANJI_RUN_NOUN_DETAILS = new Set(["一般", "固有名詞", "サ変接続"]);

  /**
   * 短い漢字トークンの連結（人名らしきラン）を検出する。
   * findLinePatternMaskIndices と同型のインターフェイス（unit index -> reason）。
   * @param {{text: string, token: object|null}[]} units
   * @returns {Map<number, string>}
   */
  function findKanjiNameRunIndices(units) {
    const result = new Map();
    let run = [];
    const flush = () => {
      const members = run.filter((r) => r.kind === "kanji");
      const kanjiLen = members.reduce((n, r) => n + r.len, 0);
      const anchored = members.some((r) => r.len === 1 || r.properNoun);
      if (members.length >= 2 && kanjiLen >= KANJI_RUN_MIN && kanjiLen <= KANJI_RUN_MAX && anchored) {
        // 端の空白はマスク対象に含めない（ランの内側の空白だけ塗る）
        while (run.length && run[0].kind === "space") run.shift();
        while (run.length && run[run.length - 1].kind === "space") run.pop();
        for (const r of run) result.set(r.i, "kanji-run");
      }
      run = [];
    };
    units.forEach((u, i) => {
      const t = u.token;
      if (!t) return flush(); // 形態素情報が無い unit はランを構成しない
      if (t.pos === "記号" && (t.pos_detail_1 === "空白" || t.surface_form.trim() === "")) {
        if (run.length) run.push({ i, kind: "space" });
        return;
      }
      const surface = t.surface_form;
      const isMember = KANJI_RUN_MEMBER.test(surface)
        && ((t.pos === "名詞" && KANJI_RUN_NOUN_DETAILS.has(t.pos_detail_1))
          || (t.pos === "形容詞" && t.pos_detail_1 === "自立"));
      if (isMember) {
        run.push({ i, kind: "kanji", len: surface.length, properNoun: t.pos_detail_1 === "固有名詞" });
      } else {
        flush();
      }
    });
    flush();
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
    judge, judgeToken, findLinePatternMaskIndices, findKanjiNameRunIndices,
    findUnitMetricIndices,
    LONG_TEXT_THRESHOLD, UI_LABEL_ALLOWLIST,
  };
})();
