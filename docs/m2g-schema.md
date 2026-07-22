# m2g メタデータ規約（mask2gemini ワイヤーフレーム出力）

このドキュメントは、mask2gemini が書き出す `.excalidraw` ファイルを
**LLM / AI Agent が読むための規約**である。cc-sdd 等で UI 改善案を作らせる際、
この文書ごと Agent のコンテキストに貼り付けて使うことを想定した自己完結の仕様。

## ファイルの正体

- 社内 Web アプリの画面スクリーンショットから、**秘匿情報（PII・業務データ）を
  マスクした上で**画面構造を抽出した Excalidraw 形式（JSON）のワイヤーフレーム
- `source: "mask2gemini"` を持つ。座標は CSS px、原点は画面左上
- **マスクされた元の文字列はファイルのどこにも含まれない**。マスクは
  ハッチ塗りの矩形としてのみ現れる

## customData.m2g — 意味のメタデータ層

抽出由来のすべての要素は `customData.m2g` を持つ。

```json
{ "customData": { "m2g": { "v": 1, "role": "masked", "reason": "dom-data", "kind": "td" } } }
```

### v — スキーマバージョン

この規約のバージョン。現在は `1`。語彙（role / reason / kind の値）や
フィールドの**追加**では上がらないので、**一覧にない値・フィールドに出会っても
無視せず「そういう種別・情報がある」として扱ってよい**（前方互換）。
既存フィールドの意味が変わる非互換変更のときだけ上がる。

### role — 要素の役割（必須）

| role | 意味 | Agent はどう扱うか |
|---|---|---|
| `masked` | 秘匿情報を伏せた枠（元はテキストや画像があった） | **ダミーデータを入れて提案してよい**。`reason` / `kind` がダミーの種類のヒント |
| `text` | 画面に残った UI テキスト（ラベル・見出し・メニュー等の実文字列） | 画面の構造・語彙の根拠として使う |
| `revealed` | 一度自動マスクされたが、人間が確認して「秘匿でない」と解除した語 | `text` と同様に扱ってよい（人間が安全と確定済み） |
| `decor` | 装飾ボックス（カード背景・罫線・グラフのバー等。実際の色を持つ） | 配色・レイアウトの根拠として使う |
| `icon` | アイコン（マスク済み画像から切り抜いた PNG の実物） | 見た目の再現に使う |

`decor` の色は元ページの実測値を sRGB の `#rrggbb[aa]` に正規化したもので、
`backgroundColor`（塗り）と `strokeColor`（枠線）を**別々に持つ**。
ページ全体の地色は `decor` ではなく **`appState.viewBackgroundColor`** に入る
（画面の基調色はここを見る）。

### reason — マスクの判定種別（role: masked / revealed のみ）

**元の文字列ではなく**「なぜ・何として塗ったか」のラベル。ダミーデータ生成のヒント:

| reason | 中身の見当 |
|---|---|
| `email` / `email-frag` / `at-mark` | メールアドレス（frag は折り返しの断片） |
| `digit-run` | 数字のラン: 電話番号・郵便番号・金額・ID・日付など |
| `digit` / `number` | 数字を含む値・数詞 |
| `proper-noun` / `jp-name-like` / `kanji-run` / `kana-name` | 人名・組織名・地名らしき語 |
| `address-suffix` | 住所の断片 |
| `dom-data` | テーブルセル・フォーム入力値などデータ位置の値（`kind` で詳細が分かる） |
| `long-text` / `ascii-word` / `unknown` / `unknown-token` | 種別不明のデータらしき文字列（ID・コード・固有の語） |
| `opaque(img)` 等 | 中身を読めなかった領域（画像・canvas・iframe）。何かのビジュアルが入る枠 |
| `manual` | 人間が手動で塗った枠（種別情報なし） |

### kind — DOM の要素種別（取れた場合のみ）

その文字列/枠がどんな要素にあったか。タグ名・role 名・フォーム部品種別のいずれか:

- 構造: `th` `td` `caption` `label` `legend` `output` `nav` `h1`〜`h6` `button` `summary`
- ARIA role: `columnheader` `rowheader` `heading` `tab` `navigation` `menu` `menubar` `menuitem` `cell` `gridcell` `row`
- フォーム: `input:text` `input:email` `input:tel` `input:date` `input:password` `input:submit` … / `select` / `textarea`
- アイコン（role: icon）: `svg` `img` `canvas` `bg-image` `glyph`（アイコンフォント） 等

例: `role: "masked", reason: "dom-data", kind: "td"` = テーブルのデータセル。
`kind: "input:email"` = メール入力欄なのでダミーのメールアドレスを入れる。

### tableId / col — テーブルの列関連付け（テーブル内の要素のみ）

テーブル（`<table>` および `role="row"` を使う div 疑似テーブル）に属する要素は
`tableId`（テーブルの序数 id）と `col`（列の序数、0 始まり）を持つ。

**同じ `tableId`・同じ `col` を持つ text（`kind: "th"` / `"columnheader"`）が、
その枠の列ヘッダ**。マスク枠のダミーデータは列ヘッダから種類を推論するのが最も確実:

- ヘッダが「氏名」の列の `masked` 枠 → ダミーの人名
- ヘッダが「金額」の列 → ダミーの金額

`col` は DOM 構造の序数（colspan/rowspan は近似）。どちらも序数であって
内容ではない。テーブル外の要素には無い。

## 読み分けの規約（重要）

- **`customData` の無い要素 = 人間（または Agent）が Excalidraw 上で後から追加した
  提案部分**。抽出由来の要素と区別して扱うこと
- 既存要素を複製すると `customData` ごとコピーされる。データ枠を増やす提案は
  既存のマスク矩形の複製ベースで行うと意味が追従する
- `groupIds` の `block-N` は元画面のブロック（カード・セル等）単位のまとまり

## Agent への指示例

> 添付の `.excalidraw` は mask2gemini が出力したワイヤーフレームです。
> `customData.m2g` を上記規約で解釈し、`role: "masked"` の枠には `reason` と
> `kind` に合ったダミーデータを補いながら、改善後の画面を提案してください。
> あなたが追加する要素には `customData` を付けないでください。
