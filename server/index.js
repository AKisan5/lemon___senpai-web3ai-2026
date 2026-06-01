import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cron from 'node-cron'
import { Client, GatewayIntentBits } from 'discord.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'tasks.json')

// ---------- データ永続化 ----------
function loadTasks() {
  if (!existsSync(DB_PATH)) return []
  try { return JSON.parse(readFileSync(DB_PATH, 'utf8')) } catch { return [] }
}
function saveTasks(tasks) {
  writeFileSync(DB_PATH, JSON.stringify(tasks, null, 2), 'utf8')
}

// ---------- Express API ----------
const app = express()
app.use(cors())
app.use(express.json())

app.get('/tasks', (_req, res) => {
  res.json(loadTasks())
})

app.post('/tasks', (req, res) => {
  const { title, deadline } = req.body
  if (!title || !deadline) return res.status(400).json({ error: 'title and deadline required' })
  const tasks = loadTasks()
  tasks.push({ id: crypto.randomUUID(), title, deadline, done: false, createdAt: new Date().toISOString() })
  saveTasks(tasks)
  res.json(tasks)
})

app.patch('/tasks/:id/toggle', (req, res) => {
  const tasks = loadTasks()
  const task = tasks.find(t => t.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'not found' })
  task.done = !task.done
  task.doneAt = task.done ? new Date().toISOString() : null
  saveTasks(tasks)
  res.json(tasks)
})

app.delete('/tasks/:id', (req, res) => {
  const tasks = loadTasks().filter(t => t.id !== req.params.id)
  saveTasks(tasks)
  res.json(tasks)
})

app.listen(3001, () => console.log('✅ API server: http://localhost:3001'))

// ---------- Discord Bot ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 8 * * *'

function daysLeft(deadline) {
  const today = new Date(); today.setHours(0,0,0,0)
  return Math.ceil((new Date(deadline) - today) / 86400000)
}

function buildDailyMessage() {
  const tasks = loadTasks().filter(t => !t.done)
  if (tasks.length === 0) return '🎉 今日のタスクはありません！'

  const sorted = tasks.sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
  const today = sorted.filter(t => daysLeft(t.deadline) === 0)
  const soon  = sorted.filter(t => { const d = daysLeft(t.deadline); return d > 0 && d <= 3 })
  const rest  = sorted.filter(t => daysLeft(t.deadline) > 3)

  const lines = ['## 📅 今日やるべきタスク\n']

  if (today.length > 0) {
    lines.push('🔴 **本日締切**')
    today.forEach(t => lines.push(`　• ${t.title}（${t.deadline}）`))
  }
  if (soon.length > 0) {
    lines.push('\n🟠 **3日以内**')
    soon.forEach(t => lines.push(`　• ${t.title}（あと${daysLeft(t.deadline)}日）`))
  }
  if (rest.length > 0) {
    lines.push('\n🟡 **その他**')
    rest.slice(0, 5).forEach(t => lines.push(`　• ${t.title}（あと${daysLeft(t.deadline)}日）`))
    if (rest.length > 5) lines.push(`　...他${rest.length - 5}件`)
  }

  lines.push(`\n📊 未完了 **${tasks.length}件** / 合計 ${loadTasks().length}件`)
  return lines.join('\n')
}

if (DISCORD_TOKEN && CHANNEL_ID) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })

  client.once('ready', () => {
    console.log(`🤖 Discord Bot ready: ${client.user.tag}`)
    console.log(`⏰ 通知スケジュール: ${CRON_SCHEDULE}`)

    cron.schedule(CRON_SCHEDULE, async () => {
      try {
        const channel = await client.channels.fetch(CHANNEL_ID)
        await channel.send(buildDailyMessage())
        console.log(`[${new Date().toLocaleString('ja-JP')}] 通知送信完了`)
      } catch (err) {
        console.error('通知エラー:', err.message)
      }
    }, { timezone: 'Asia/Tokyo' })
  })

  client.login(DISCORD_TOKEN).catch(err => {
    console.error('Discord ログイン失敗:', err.message)
    console.error('DISCORD_TOKEN を .env で確認してください')
  })
} else {
  console.warn('⚠️  DISCORD_TOKEN / DISCORD_CHANNEL_ID が未設定です。')
  console.warn('   server/.env を作成して設定してください（.env.example 参照）')
}
