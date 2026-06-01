const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const matter = require('gray-matter')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

// Obsidian の Tasks フォルダパス（.env で上書き可能）
const TASKS_DIR = process.env.OBSIDIAN_TASKS_DIR || 'C:\\Aki\\my-vault\\Tasks'

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true })
}

/**
 * Tasks フォルダ内の .md ファイルをすべて読み込んで配列で返す
 * _ から始まるファイル（_README.md 等）は除外
 */
function readAllTasks() {
  ensureDir()
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(filename => {
      try {
        const raw = fs.readFileSync(path.join(TASKS_DIR, filename), 'utf8')
        const { data } = matter(raw)
        if (!data.id || !data.title) return null

        // gray-matter は YYYY-MM-DD を Date オブジェクトに変換することがある
        const deadline = data.deadline instanceof Date
          ? data.deadline.toISOString().split('T')[0]
          : String(data.deadline || '')
        const created = data.created instanceof Date
          ? data.created.toISOString().split('T')[0]
          : String(data.created || '')

        return {
          id: data.id,
          title: data.title,
          deadline,
          status: data.status || 'todo',
          tags: data.tags || [],
          created,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * タスクを .md ファイルとして書き込む
 * 既存ファイルがあれば上書き（メモ本文は保持）
 */
function writeTaskFile(task) {
  ensureDir()
  const filepath = path.join(TASKS_DIR, `${task.id}.md`)

  // 既存ファイルがあれば本文（メモ）を保持する
  let existingBody = ''
  if (fs.existsSync(filepath)) {
    const raw = fs.readFileSync(filepath, 'utf8')
    existingBody = matter(raw).content.trim()
  }
  const body = existingBody || '\n## メモ\n\n（ここに追記できる）\n'

  const content = matter.stringify(body, {
    id: task.id,
    title: task.title,
    deadline: task.deadline,
    status: task.status,
    tags: task.tags || [],
    created: task.created,
    updated: new Date().toISOString().split('T')[0],
  })
  fs.writeFileSync(filepath, content, 'utf8')
}

// ─── エンドポイント ───────────────────────────────────────────

// GET /tasks — 全タスク取得
app.get('/tasks', (_req, res) => {
  res.json(readAllTasks())
})

// POST /tasks — タスク新規作成
app.post('/tasks', (req, res) => {
  const { title, deadline } = req.body
  if (!title || !deadline) {
    return res.status(400).json({ error: 'title と deadline は必須です' })
  }
  const id = `task_${Date.now()}`
  writeTaskFile({
    id,
    title,
    deadline,
    status: 'todo',
    tags: [],
    created: new Date().toISOString().split('T')[0],
  })
  res.status(201).json(readAllTasks())
})

// PATCH /tasks/:id/status — ステータス更新
app.patch('/tasks/:id/status', (req, res) => {
  const tasks = readAllTasks()
  const task = tasks.find(t => t.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' })
  task.status = req.body.status
  writeTaskFile(task)
  res.json(readAllTasks())
})

// DELETE /tasks/:id — タスク削除
app.delete('/tasks/:id', (req, res) => {
  const tasks = readAllTasks()
  const task = tasks.find(t => t.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' })
  const filepath = path.join(TASKS_DIR, `${task.id}.md`)
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
  res.json(readAllTasks())
})

// ─── 起動 ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ Obsidian Tasks サーバー起動中: http://localhost:${PORT}`)
  console.log(`📁 タスクフォルダ: ${TASKS_DIR}`)
})
