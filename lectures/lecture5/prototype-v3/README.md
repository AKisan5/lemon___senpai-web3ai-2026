# 締め切り管理 — deadline-app (v3)

第3回宿題で設計した VPC「**20. ★ 締め切りを忘れてしまう**」に対するプロトタイプ。

> **v3 の変更点**
> - **カラム上限（WIP 制限）を追加** — タスクがたまり続けるのを防ぐため、**To Do は 30 件**、**In Progress は 5 件**までに制限。上限に達したカラムへの新規追加・移動はブロックし、ヘッダーのカウントは「件数 / 上限」表示で満杯時に赤くなる（Done は無制限）。
> - **【バグ修正】`sources`（参照ノート）の消失** — v2 では `generateMarkdown` が `sources` を frontmatter に書き出しておらず、参照ノート付きタスクを移動・編集すると消えていた。v3 で書き戻すよう修正。

タスクを **To Do / In Progress / Done** のカンバンで管理し、データは Obsidian Vault 内の `Tasks/` フォルダに `.md` ファイルとして保存する。`Obsidian Local REST API` プラグインを介してブラウザから直接 Vault に書き込むため、独自のデータベースは持たない。

---

## 機能

- カンバン表示（To Do / In Progress / Done）／**カレンダー表示**（月ビュー）の切替
- カラム上限（WIP 制限）: To Do 30 件 / In Progress 5 件（Done は無制限）。満杯カラムへの追加・移動はブロック
- **既存タスクの編集**（タイトル・締切・担当・優先度・AI指示・タグ・参照ノート・メモを後から変更可）
- **締切リマインドのブラウザ通知**（締切超過・今日・明日の未完了タスクを1日1回まとめて通知）
- 締め切りまでの残日数表示（今日締切 / 期限超過は赤、近日中は橙、余裕は緑）
- 優先度（高 / 中 / 低）と担当者（Human / Claude / Claude Code / Gemini / GPT-4o）でのフィルター・ソート
- 各タスクに「AI への指示（ai_context）」「参照ノート（sources）」「メモ本文」を添付可能
- 参照ノートは `obsidian://` URI スキームでワンクリックで Obsidian 側を開く
- API キーは `localStorage` に保存され、再アクセス時に自動で接続
- 全ての CRUD 操作が Obsidian Vault の `.md` ファイルにそのまま反映される

---

## 動作要件

- Node.js 18+
- Obsidian
- Obsidian コミュニティプラグイン: [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
- Vault のルートに `Tasks/` フォルダ

---

## セットアップ

### 1. Obsidian Local REST API プラグインを準備

1. Obsidian の「設定 → コミュニティプラグイン」から `Local REST API` をインストール・有効化
2. プラグイン設定で **API Key** をコピーしておく
3. プラグインがデフォルトで `https://localhost:27124` をリッスンしていることを確認

> ⚠️ Local REST API の HTTPS（27124）は自己署名証明書を使うため、ブラウザから直接 fetch するとブロックされる。
> - **ローカル開発（`npm run dev`）**: `vite.config.js` の dev プロキシ（`server.proxy` の `secure: false`）が `/obsidian` を `https://localhost:27124` に中継し、証明書の壁を回避する。追加の手動承認は不要。
> - **本番（Vercel 等の静的ホスティング）**: プロキシが無いためブラウザが直接 `https://localhost:27124` を叩く。各ユーザーが一度だけ `https://localhost:27124` にアクセスして自己署名証明書を信頼する必要がある（Vivaldi/Chrome なら「詳細設定 → このまま続行」）。HTTP（27123）と HTTPS の混在はブラウザにブロックされるため HTTPS を使う。

### 2. ローカルで起動

```bash
cd lectures/lecture5/prototype
npm install
npm run dev
```

ブラウザで [http://localhost:5173/](http://localhost:5173/) にアクセスし、API キーを入力すれば接続完了。

### 3. ビルド（本番用）

```bash
npm run build
```

`dist/` に静的ファイルが生成される。

---

## Vercel へのデプロイ

ルートに `vercel.json` を配置済みで、Vite の標準的な静的サイト構成として動作する。

1. GitHub リポジトリを Vercel に連携
2. **Root Directory** に `lectures/lecture5/prototype` を指定
3. Framework Preset は自動検出で `Vite`
4. Build Command: `npm run build` / Output Directory: `dist`（`vercel.json` で指定済み）
5. デプロイ後に得られる `https://*.vercel.app` から接続可能

> Vercel 側からは `https://localhost:27124` に接続しに行く。ユーザー自身のマシンで Obsidian と Local REST API が起動していれば、各ユーザーのブラウザから直接ローカルへ接続される（サーバー経由ではない）。

---

## 構成

```
prototype/
├── index.html
├── package.json
├── vercel.json           Vercel デプロイ設定
├── vite.config.js
├── src/
│   ├── main.jsx          React エントリ
│   └── App.jsx           本体ロジック（フロントマター parser、API クライアント、UI）
└── server/               ローカル開発用の代替 Express サーバー（任意）
    └── index.js
```

`server/` は Local REST API プラグインを使いたくない場合の予備実装。本番フローでは未使用。

---

## タスクファイルのフォーマット

`Tasks/{id}.md` として保存され、フロントマターはこの形式：

```yaml
---
id: task_1780000000000
title: レポート提出
deadline: 2026-06-10
status: todo
assignee: human
priority: high
ai_context: "[[英語の勉強.md]] を参考にして課題を作成"
tags:
  - 課題
created: 2026-06-03
updated: 2026-06-03
---

## メモ

（自由記述）
```

`status` は `todo` / `in_progress` / `done` の3値。

---

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `Obsidian未接続` の赤バッジ | Obsidian が起動しているか / Local REST API プラグインが有効か確認 |
| `APIキーが正しくありません` | プラグイン設定からキーを再コピー。空白混入に注意 |
| ローカル開発でログイン画面から進めない | dev プロキシが効いているか確認。`npm run dev` を再起動（`vite.config.js` 変更は再起動が必要）。`/obsidian` への接続が 200 を返すか確認 |
| 本番（Vercel）でブラウザに証明書エラーが出る | `https://localhost:27124` に一度直接アクセスして自己署名証明書を許可 |
| Vercel デプロイ後に接続できない | ローカルで Obsidian と Local REST API が起動しているか確認。HTTP の `27123` ではなく HTTPS の `27124` を使っていることを確認 |

---

## VPC との対応

| 設計（VPC v1） | 実装 |
|---|---|
| 締め切りの一元管理 | Vault の `Tasks/` フォルダにファイル化 |
| 優先度の可視化 | `priority` フィールドとカンバン左ボーダーカラー |
| 締め切りの可視化 | 残日数バッジ（赤 / 橙 / 緑） |
| AI 連携 | `ai_context` で AI 用の指示を埋め込み、`sources` で参照 Vault ノートを紐付け |

---

## ライセンス

学習用プロトタイプ。
