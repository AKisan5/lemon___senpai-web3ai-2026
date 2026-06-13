# deadline-app v3 開発ログ

deadline-app（締め切り管理カンバン）の v2 → v3 アップデート開発記録。
ユーザーとの会話で決まった方針、各ファイルの変更内容、検証結果を時系列で記録する。

> このログは作業の進行に合わせて随時追記する（後からまとめてではなく、変更のたびに書く）。

---

## 背景・経緯

- 対象: `lectures/lecture5/prototype`（v2）。React + Vite の単一 `App.jsx`、データは Obsidian Vault の `Tasks/*.md` に Local REST API 経由で保存するカンバン。VPC「締め切りを忘れてしまう」のプロトタイプ。
- ユーザー要望: v2 をアップデートして **v3 を別ディレクトリで** 作りたい。

### 会話で確定した方針

1. **v3 のスコープ（テーマ）**: A（締切リマインド）＋ C（操作性UX）＋ D（バグ修正・堅牢化）。
   - **B（AI を実際に動かす連携）は今回は見送り**。
2. **配置**: v2 を温存し、別ディレクトリ `prototype-v3/` で開発。
3. **カラム上限（WIP 制限）**:
   - **To Do = 30 件**、**In Progress（プログレス）= 5 件**、Done = 無制限。
   - 到達時の挙動は **ハードブロック**（上限カラムへの新規追加・移動を禁止し警告表示）をデフォルトとした。
4. **着手順**: D（土台修正）→ C（編集UI＋タグ/sources入力）→ A（通知・カレンダー）。

---

## 変更履歴

### 2026-06-13 #1 — v3 ディレクトリ作成・カラム上限・sources バグ修正

**ディレクトリ作成**
- `prototype-v3/` を新規作成し、v2 のソースを node_modules / dist を除いてコピー
  （`index.html`, `package.json`, `vite.config.js`, `vercel.json`, `.gitignore`, `README.md`, `src/*.jsx`, `server/`）。

**`src/App.jsx`**
- `COLUMNS` に各カラムの `limit` を追加（todo:30 / in_progress:5 / done:null）。`COLUMN_LIMIT` マップを定義。
- `countByStatus()` / `isColumnFull()` ヘルパーを追加（アサインフィルターに関係なく実件数で判定）。
- `addTask()`: To Do が上限なら追加をブロックして警告。
- `moveTask()`: 移動先カラムが上限なら移動をブロックして警告。
- カラムヘッダーのカウント表示を「件数 / 上限」に変更。満杯時は赤＋「満杯」表示、上部ボーダーも赤。
- 「→ 移動」ボタンを満杯カラム宛で無効化。フォームの「追加」ボタンを To Do 満杯時に無効化＋注意書き。
- **【バグ修正 D】** `generateMarkdown()` が `sources` を frontmatter に書き出していなかったため、参照ノート付きタスクを移動・編集すると消えていた問題を修正（`sources` リストを出力するよう追加）。

**`package.json`** — version を `0.1.0` → `0.3.0`。

**`README.md`** — タイトルを「(v3)」に。冒頭に v3 変更点、機能リストにカラム上限を追記。

**検証** — `npm install`（63 packages）→ `npm run build` 成功（30 modules transformed、エラーなし）。

### 2026-06-13 #2 — C: 既存タスクの編集機能 ＋ タグ/参照ノート入力UI

**`src/App.jsx`**
- `splitList()` ヘルパー追加（カンマ区切り文字列→配列）。
- 状態追加: `tagsInput` / `sourcesInput`（追加フォーム用）、`editingId` / `draft`（編集用）。
- `addTask()`: タグ・参照ノートを `splitList` で配列化して保存するよう変更（v2 では tags 常に空・sources 未対応だった）。
- `startEdit()` / `cancelEdit()` / `saveEdit()` を追加。既存タスクの **タイトル・締切・担当・優先度・AI指示・タグ・参照ノート・メモ** を後から編集可能に（v2 は作成後に変更不可だった）。
- 追加フォームに「タグ」「参照ノート」入力欄を追加。
- カード展開パネルに編集モード（インライン編集フォーム）を実装。アクション行に「✎ 編集」ボタンを追加し、編集中は移動/削除ボタンを隠す。
- 編集フォーム用スタイル `editLabel` / `editInput` を追加。

**検証** — `npm run build` 成功（エラーなし）。

### 2026-06-13 #3 — A: 締切リマインド（ブラウザ通知 ＋ カレンダービュー）

**`src/App.jsx`**
- `urgentTasks()` ヘルパー追加（締切が超過・今日・明日の未完了タスクを抽出）。
- `CalendarBoard` コンポーネントを新規追加（月表示・前月/翌月/今月ナビ・締切日にタスクチップ表示・日曜赤/土曜青・本日ハイライト）。タスククリックでカンバンに戻り当該タスクを展開。
- 状態追加: `view`（'kanban' | 'calendar'）、`notifyOn`。
- ブラウザ通知の `useEffect` を追加。通知許可済みかつ当日未通知なら、締切間近の未完了タスクをまとめて1回通知（`localStorage` の `deadline-last-notified` で日次デデュープ）。
- `enableNotifications()` を追加（`Notification.requestPermission()`）。
- ヘッダーに **ビュー切替トグル（🗂カンバン / 📆カレンダー）** と **通知 ON/OFF ボタン** を追加。
- ボード描画を `view` で分岐（カレンダー時は `CalendarBoard`）。

**検証** — `npm run build` 成功（30 modules、エラーなし）。

### 2026-06-13 #4 — AI指示のワンクリックコピー ＋ ドラッグ&ドロップ

ユーザー要望: (1) AI担当タスクの指示をビューを開かず簡単にコピーしたい、(2) ドラッグ&ドロップでカラム移動したい、(3) ひと段落したら開発リポジトリ（`lemon___senpai-web3ai-2026`）に GitHub プッシュ。

**`src/App.jsx`**
- `isAiAssignee()` / `buildAiPrompt()` / `copyToClipboard()` を module レベルに追加。`buildAiPrompt` はタイトル・締切・AI指示・参照ノート・メモを整形した貼り付け用テキストを生成。`copyToClipboard` は `navigator.clipboard` + `execCommand` フォールバック。
- 状態追加: `copiedId`（コピー完了フィードバック）、`draggingId` / `dragOverCol`（DnD）。
- `copyPrompt()` / `onDropToColumn()` を追加。
- **AI担当タスク（human 以外）のカードに「📋 ◯◯への指示をコピー」ボタン**を常時表示（展開不要）。コピー後 1.5 秒「✓ コピーしました」表示。
- **ドラッグ&ドロップ**: カードを `draggable` 化（編集中は無効）、ドラッグ中は半透明。カラム本体に `onDragOver`/`onDragLeave`/`onDrop` を実装し、ドロップで `moveTask`。ドロップ先カラムを点線でハイライト（満杯カラムは赤＋「満杯です」）。上限ブロックは `moveTask` 側で従来どおり機能。

**検証** — `npm run build` 成功（30 modules、エラーなし）。dev サーバー（localhost:5174）で HMR 反映確認。

**この後** — GitHub（origin: `github.com/AKisan5/lemon___senpai-web3ai-2026`、main）へプッシュ。

### 残タスク（次回以降）
- A の Discord 通知（`server/` 活用、常時起動サーバー前提）は未着手。
- D の残り: 編集衝突対策、Vault名/Tasksパスの設定外部化、frontmatter parser のさらなる堅牢化、`App.jsx` のコンポーネント分割。
- 検索（C）は未着手。
