import { useState, useEffect, useCallback } from 'react'

// 開発時（npm run dev）は Vite の dev プロキシ（vite.config.js）経由で接続し、
// 自己署名証明書の問題を回避する。本番ビルド（Vercel 等）ではプロキシが無いため
// 直接 HTTPS エンドポイントを叩く（ユーザーは一度だけ証明書を承認する必要がある）。
const OBSIDIAN_API = import.meta.env.DEV ? '/obsidian' : 'https://localhost:27124'
const TASKS_PATH = 'Tasks'
const API_KEY_STORAGE = 'obsidian-local-rest-api-key'

const COLUMNS = [
  { key: 'todo',        label: 'To Do',      color: '#718096', bg: '#F7FAFC', limit: 30 },
  { key: 'in_progress', label: 'In Progress', color: '#3182CE', bg: '#EBF8FF', limit: 5 },
  { key: 'done',        label: 'Done',        color: '#38A169', bg: '#F0FFF4', limit: null },
]

// カラムごとの上限件数（null は無制限）。タスクがたまり続けるのを防ぐための WIP 制限。
// To Do は 30 件、In Progress は 5 件まで。上限に達したカラムへの新規追加・移動はブロックする。
const COLUMN_LIMIT = Object.fromEntries(COLUMNS.map(c => [c.key, c.limit]))

const ASSIGNEES = {
  'claude-code': { label: 'Claude Code', color: '#6B46C1', bg: '#FAF5FF' },
  'claude':      { label: 'Claude',      color: '#2B6CB0', bg: '#EBF8FF' },
  'gemini':      { label: 'Gemini',      color: '#276749', bg: '#F0FFF4' },
  'gpt-4o':      { label: 'GPT-4o',     color: '#744210', bg: '#FFFBEB' },
  'human':       { label: '人間',        color: '#C53030', bg: '#FFF5F5' },
}

const PRIORITIES = {
  high:   { label: '高', color: '#E53E3E' },
  medium: { label: '中', color: '#D69E2E' },
  low:    { label: '低', color: '#38A169' },
}

const VAULT_NAME = 'my-vault'

// ─── YAML frontmatter parser ──────────────────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const fm = {}
  const lines = match[1].split(/\r?\n/)
  let currentKey = null
  let listItems = []
  let inList = false

  const flush = () => {
    if (inList && currentKey) { fm[currentKey] = listItems; listItems = []; inList = false }
  }

  for (const line of lines) {
    if (inList && /^  - /.test(line)) {
      listItems.push(line.slice(4))
      continue
    }
    flush()
    const m = line.match(/^(\w[\w_-]*): ?(.*)$/)
    if (!m) continue
    const [, key, val] = m
    currentKey = key
    if (val === '' || val === '[]') {
      inList = true; listItems = []
    } else {
      fm[key] = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
  }
  flush()

  return { frontmatter: fm, body: match[2].trim() }
}

function generateMarkdown(task) {
  const today = new Date().toISOString().split('T')[0]
  const tags = Array.isArray(task.tags) && task.tags.length > 0
    ? '\ntags:\n' + task.tags.map(t => `  - ${t}`).join('\n')
    : ''
  // sources（参照ノート）を frontmatter に書き戻す。v2 では出力しておらず、
  // sources 付きタスクを移動・編集すると参照が消えるバグがあった（v3 で修正）。
  const sources = Array.isArray(task.sources) && task.sources.length > 0
    ? '\nsources:\n' + task.sources.map(s => `  - ${s}`).join('\n')
    : ''
  const aiCtx = (task.ai_context || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  return `---
id: ${task.id}
title: ${task.title}
deadline: ${task.deadline}
status: ${task.status}
assignee: ${task.assignee}
priority: ${task.priority}
ai_context: "${aiCtx}"${tags}${sources}
created: ${task.created || today}
updated: ${today}
---

## メモ

${task.memo || ''}
`
}

// ─── Obsidian Local REST API helpers ─────────────────────────────────────
function obsFetch(path, apiKey, options = {}) {
  const cleanKey = String(apiKey || '').trim().replace(/^bearer\s+/i, '')
  return fetch(`${OBSIDIAN_API}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cleanKey}`,
      ...options.headers,
    },
  })
}

async function listTaskFiles(apiKey) {
  const res = await obsFetch(`vault/${TASKS_PATH}/`, apiKey)
  if (!res.ok) throw new Error(`list failed: ${res.status}`)
  const data = await res.json()
  return (data.files || []).filter(f => !f.startsWith('_') && f.endsWith('.md'))
}

async function readTask(apiKey, filename) {
  const res = await obsFetch(`vault/${TASKS_PATH}/${filename}`, apiKey)
  if (!res.ok) return null
  const text = await res.text()
  const { frontmatter, body } = parseFrontmatter(text)
  if (!frontmatter.id) return null
  return { ...frontmatter, memo: body, _filename: filename }
}

async function writeTask(apiKey, task) {
  const filename = task._filename || `${task.id}.md`
  const md = generateMarkdown(task)
  const res = await obsFetch(`vault/${TASKS_PATH}/${filename}`, apiKey, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: md,
  })
  if (!res.ok) throw new Error(`write failed: ${res.status}`)
  return filename
}

async function deleteTaskFile(apiKey, filename) {
  const res = await obsFetch(`vault/${TASKS_PATH}/${filename}`, apiKey, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete failed: ${res.status}`)
}

// ─── Utilities ─────────────────────────────────────────────────────────────
function daysLeft(deadline) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.ceil((new Date(deadline) - today) / 86400000)
}
function urgencyColor(days) {
  if (days < 0)   return '#718096'
  if (days === 0) return '#E53E3E'
  if (days <= 2)  return '#DD6B20'
  if (days <= 7)  return '#D69E2E'
  return '#38A169'
}
function urgencyLabel(days) {
  if (days < 0)   return `${Math.abs(days)}日超過`
  if (days === 0) return '今日締切！'
  if (days === 1) return '明日締切'
  return `あと${days}日`
}
function normalizeStatus(task) {
  if (task.status) return task.status
  return task.done ? 'done' : 'todo'
}
function obsidianUri(src) {
  const file = String(src).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '')
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(file)}`
}
function sourceLabel(src) {
  return String(src).replace(/\.md$/, '')
}
// カンマ区切り文字列 → トリム済み配列（空要素は除去）。タグ・参照ノート入力の解析に使う。
function splitList(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean)
}
// 締切が「明日まで（超過・今日・明日）」の未完了タスク。リマインド通知の対象。
function urgentTasks(tasks) {
  return tasks.filter(t => normalizeStatus(t) !== 'done' && t.deadline && daysLeft(t.deadline) <= 1)
}
const NOTIFY_DATE_KEY = 'deadline-last-notified'

// 担当者が AI（人間以外）かどうか
function isAiAssignee(a) {
  return !!a && a !== 'human'
}
// AI に貼り付ける指示テキストを組み立てる。ai_context を主に、参照ノートを補足として付ける。
function buildAiPrompt(task) {
  const lines = [`# タスク: ${task.title || ''}`]
  if (task.deadline) lines.push(`締切: ${task.deadline}`)
  lines.push('')
  lines.push(task.ai_context ? task.ai_context : '（AIへの指示が未設定です）')
  const sources = Array.isArray(task.sources) ? task.sources : []
  if (sources.length) {
    lines.push('')
    lines.push('参照ノート:')
    sources.forEach(s => lines.push(`- ${s}`))
  }
  if (task.memo) {
    lines.push('')
    lines.push('メモ:')
    lines.push(task.memo)
  }
  return lines.join('\n')
}
// クリップボードにコピー（execCommand フォールバック付き）
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* フォールバックへ */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ─── API Key Setup Screen ──────────────────────────────────────────────────
function ApiKeySetup({ onSave }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const cleanKey = key.trim().replace(/^bearer\s+/i, '')
    if (!cleanKey) { setError('APIキーを入力してください'); return }
    setTesting(true)
    setError('')
    try {
      const res = await obsFetch(`vault/${TASKS_PATH}/`, cleanKey)
      if (res.ok || res.status === 404) {
        localStorage.setItem(API_KEY_STORAGE, cleanKey)
        onSave(cleanKey)
      } else if (res.status === 401) {
        setError('APIキーが正しくありません')
      } else {
        setError(`接続エラー (${res.status})。ObsidianとLocal REST APIプラグインが起動しているか確認してください`)
      }
    } catch {
      setError('Obsidianに接続できません。Local REST APIプラグインが有効か確認してください（Obsidian設定 → コミュニティプラグイン → Local REST API）')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F0F2F5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 40, maxWidth: 480, width: '100%', boxShadow: '0 4px 24px rgba(0,0,0,0.10)' }}>
        <div style={{ fontSize: 32, marginBottom: 8, textAlign: 'center' }}>🔐</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, textAlign: 'center', marginBottom: 8, color: '#1A202C' }}>Obsidian 接続設定</h2>
        <p style={{ fontSize: 13, color: '#718096', textAlign: 'center', marginBottom: 24, lineHeight: 1.6 }}>
          Obsidian Local REST API のAPIキーを入力してください。<br />
          <span style={{ color: '#A0AEC0' }}>Obsidian設定 → Local REST API → API Key</span>
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="APIキーを貼り付け"
            value={key}
            onChange={e => setKey(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
            autoFocus
          />
          {error && <p style={{ color: '#E53E3E', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <button
            type="submit"
            disabled={testing}
            style={{ width: '100%', padding: '10px', fontWeight: 700, fontSize: 14, background: testing ? '#A0AEC0' : '#3182CE', color: '#fff', border: 'none', borderRadius: 8, cursor: testing ? 'not-allowed' : 'pointer' }}
          >
            {testing ? '接続確認中...' : '接続する'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Calendar View（A: カレンダービュー） ───────────────────────────────────
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
function CalendarBoard({ tasks, onSelect }) {
  const now = new Date()
  const [ref, setRef] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const todayStr = new Date(); todayStr.setHours(0, 0, 0, 0)
  const todayKey = `${todayStr.getFullYear()}-${String(todayStr.getMonth() + 1).padStart(2, '0')}-${String(todayStr.getDate()).padStart(2, '0')}`

  const first = new Date(ref.y, ref.m, 1)
  const startDay = first.getDay()
  const daysInMonth = new Date(ref.y, ref.m + 1, 0).getDate()
  const fmt = (d) => `${ref.y}-${String(ref.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  // 締切日 → タスク配列
  const byDate = {}
  tasks.forEach(t => { if (t.deadline) (byDate[t.deadline] ||= []).push(t) })

  const cells = []
  for (let i = 0; i < startDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const shift = (delta) => {
    let m = ref.m + delta, y = ref.y
    if (m < 0) { m = 11; y-- }
    if (m > 11) { m = 0; y++ }
    setRef({ y, m })
  }
  const navBtn = { fontSize: 13, padding: '4px 12px', border: '1px solid #CBD5E0', borderRadius: 6, background: '#fff', color: '#4A5568', cursor: 'pointer', fontWeight: 600 }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #E2E8F0' }}>
          <button onClick={() => shift(-1)} style={navBtn}>‹ 前月</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{ref.y}年 {ref.m + 1}月</span>
            <button onClick={() => setRef({ y: now.getFullYear(), m: now.getMonth() })} style={{ ...navBtn, fontSize: 12, padding: '2px 10px' }}>今月</button>
          </div>
          <button onClick={() => shift(1)} style={navBtn}>翌月 ›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {WEEKDAYS.map((w, i) => (
            <div key={w} style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, padding: '6px 0', color: i === 0 ? '#E53E3E' : i === 6 ? '#3182CE' : '#718096', borderBottom: '1px solid #E2E8F0' }}>{w}</div>
          ))}
          {cells.map((d, i) => {
            const key = d ? fmt(d) : null
            const dayTasks = (key && byDate[key]) || []
            const isToday = key === todayKey
            return (
              <div key={i} style={{ minHeight: 84, borderRight: '1px solid #EDF2F7', borderBottom: '1px solid #EDF2F7', padding: 4, background: isToday ? '#EBF8FF' : d ? '#fff' : '#F7FAFC', overflow: 'hidden' }}>
                {d && (
                  <div style={{ fontSize: 11, fontWeight: isToday ? 700 : 600, color: isToday ? '#2B6CB0' : (i % 7 === 0 ? '#E53E3E' : i % 7 === 6 ? '#3182CE' : '#A0AEC0'), marginBottom: 2 }}>{d}</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {dayTasks.slice(0, 4).map(t => {
                    const asgn = ASSIGNEES[t.assignee] || ASSIGNEES['human']
                    const done = normalizeStatus(t) === 'done'
                    return (
                      <div key={t.id} onClick={() => onSelect && onSelect(t)} title={t.title}
                        style={{ fontSize: 10, padding: '1px 4px', borderRadius: 3, borderLeft: `3px solid ${asgn.color}`, background: asgn.bg, color: done ? '#A0AEC0' : '#2D3748', textDecoration: done ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: onSelect ? 'pointer' : 'default' }}>
                        {t.title}
                      </div>
                    )
                  })}
                  {dayTasks.length > 4 && <div style={{ fontSize: 9, color: '#A0AEC0', paddingLeft: 4 }}>+{dayTasks.length - 4}件</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey]       = useState(() => localStorage.getItem(API_KEY_STORAGE) || '')
  const [tasks, setTasks]         = useState([])
  const [title, setTitle]         = useState('')
  const [deadline, setDeadline]   = useState('')
  const [assignee, setAssignee]   = useState('human')
  const [priority, setPriority]   = useState('medium')
  const [aiContext, setAiContext]  = useState('')
  const [tagsInput, setTagsInput]  = useState('')
  const [sourcesInput, setSourcesInput] = useState('')
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [filterAssignee, setFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)
  const [connError, setConnError] = useState(false)
  const [editingId, setEditingId] = useState(null)   // 編集中タスクの id
  const [draft, setDraft]         = useState(null)    // 編集中の下書き
  const [view, setView]           = useState('kanban') // 'kanban' | 'calendar'
  const [notifyOn, setNotifyOn]   = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted')
  const [copiedId, setCopiedId]   = useState(null)    // 指示コピーのフィードバック対象 id
  const [draggingId, setDraggingId] = useState(null)  // ドラッグ中タスクの id
  const [dragOverCol, setDragOverCol] = useState(null) // ドラッグオーバー中のカラム key

  const fetchTasks = useCallback(async (key = apiKey) => {
    setLoading(true)
    setConnError(false)
    try {
      const files = await listTaskFiles(key)
      const results = await Promise.all(files.map(f => readTask(key, f)))
      setTasks(results.filter(Boolean))
    } catch (e) {
      console.error(e)
      setConnError(true)
    } finally {
      setLoading(false)
    }
  }, [apiKey])

  useEffect(() => {
    if (apiKey) fetchTasks(apiKey)
    else setLoading(false)
  }, [apiKey])

  // ─── 締切リマインド通知（A） ───────────────────────────────
  // タスク読み込み後、通知が許可されていて当日まだ通知していなければ、
  // 締切間近（超過・今日・明日）の未完了タスクをまとめて1回だけ通知する。
  useEffect(() => {
    if (!notifyOn || loading || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const urgent = urgentTasks(tasks)
    if (urgent.length === 0) return
    const today = new Date().toISOString().split('T')[0]
    if (localStorage.getItem(NOTIFY_DATE_KEY) === today) return
    localStorage.setItem(NOTIFY_DATE_KEY, today)
    const overdue = urgent.filter(t => daysLeft(t.deadline) < 0).length
    const todayCnt = urgent.filter(t => daysLeft(t.deadline) === 0).length
    const parts = []
    if (overdue)  parts.push(`期限超過 ${overdue}件`)
    if (todayCnt) parts.push(`今日締切 ${todayCnt}件`)
    parts.push(`要対応 ${urgent.length}件`)
    try {
      new Notification('📅 締め切りリマインド', {
        body: parts.join(' / ') + '\n' + urgent.slice(0, 3).map(t => `・${t.title}（${urgencyLabel(daysLeft(t.deadline))}）`).join('\n'),
      })
    } catch { /* 通知失敗は無視 */ }
  }, [tasks, notifyOn, loading])

  async function enableNotifications() {
    if (typeof Notification === 'undefined') { setError('このブラウザは通知に対応していません'); return }
    if (Notification.permission === 'granted') { setNotifyOn(true); return }
    const perm = await Notification.requestPermission()
    if (perm === 'granted') {
      setNotifyOn(true)
      localStorage.removeItem(NOTIFY_DATE_KEY) // 有効化直後に1回通知できるようリセット
    } else {
      setError('通知がブロックされています。ブラウザの設定で許可してください')
    }
  }

  if (!apiKey) {
    return <ApiKeySetup onSave={key => { setApiKey(key); fetchTasks(key) }} />
  }

  // 指定ステータスの現在件数（アサインフィルターに関係なく全タスクで数える）
  function countByStatus(status) {
    return tasks.filter(t => normalizeStatus(t) === status).length
  }
  // 上限に達していれば true。null（無制限）なら常に false。
  function isColumnFull(status) {
    const limit = COLUMN_LIMIT[status]
    return limit != null && countByStatus(status) >= limit
  }

  async function addTask(e) {
    e.preventDefault()
    if (!title.trim()) { setError('タスク名を入力してください'); return }
    if (!deadline)     { setError('締切日を選んでください'); return }
    if (isColumnFull('todo')) {
      setError(`To Do は上限 ${COLUMN_LIMIT.todo} 件に達しています。既存のタスクを進行/完了させてから追加してください`)
      return
    }

    const id = `task_${Date.now()}`
    const newTask = {
      id,
      title: title.trim(),
      deadline,
      status: 'todo',
      assignee,
      priority,
      ai_context: aiContext,
      tags: splitList(tagsInput),
      sources: splitList(sourcesInput),
      memo: '',
      created: new Date().toISOString().split('T')[0],
      _filename: `${id}.md`,
    }

    try {
      await writeTask(apiKey, newTask)
      setTasks(prev => [...prev, newTask])
      setTitle(''); setDeadline(''); setAssignee('human')
      setPriority('medium'); setAiContext(''); setTagsInput(''); setSourcesInput('')
      setError(''); setShowForm(false)
    } catch (err) {
      setError('保存に失敗しました: ' + err.message)
    }
  }

  // ─── 編集（C: 既存タスクの編集機能） ─────────────────────────────
  function startEdit(task) {
    setEditingId(task.id)
    setExpandedId(task.id)
    setError('')
    setDraft({
      title: task.title || '',
      deadline: task.deadline || '',
      assignee: task.assignee || 'human',
      priority: task.priority || 'medium',
      ai_context: task.ai_context || '',
      tags: (Array.isArray(task.tags) ? task.tags : []).join(', '),
      sources: (Array.isArray(task.sources) ? task.sources : []).join(', '),
      memo: task.memo || '',
    })
  }
  function cancelEdit() { setEditingId(null); setDraft(null); setError('') }

  async function saveEdit(task) {
    if (!draft) return
    if (!draft.title.trim()) { setError('タスク名を入力してください'); return }
    if (!draft.deadline)     { setError('締切日を選んでください'); return }
    const updated = {
      ...task,
      title: draft.title.trim(),
      deadline: draft.deadline,
      assignee: draft.assignee,
      priority: draft.priority,
      ai_context: draft.ai_context,
      tags: splitList(draft.tags),
      sources: splitList(draft.sources),
      memo: draft.memo,
    }
    try {
      await writeTask(apiKey, updated)
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
      setEditingId(null); setDraft(null); setError('')
    } catch (err) {
      setError('更新に失敗: ' + err.message)
    }
  }

  async function moveTask(id, status) {
    const task = tasks.find(t => t.id === id)
    if (!task) return
    if (status !== normalizeStatus(task) && isColumnFull(status)) {
      const col = COLUMNS.find(c => c.key === status)
      setError(`${col?.label || status} は上限 ${COLUMN_LIMIT[status]} 件に達しています。先に他のタスクを移動してください`)
      return
    }
    const updated = { ...task, status }
    try {
      await writeTask(apiKey, updated)
      setTasks(prev => prev.map(t => t.id === id ? updated : t))
    } catch (err) {
      setError('更新に失敗: ' + err.message)
    }
  }

  async function removeTask(id) {
    const task = tasks.find(t => t.id === id)
    if (!task) return
    try {
      await deleteTaskFile(apiKey, task._filename || `${id}.md`)
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch (err) {
      setError('削除に失敗: ' + err.message)
    }
  }

  // AIへの指示をクリップボードにコピー（カードからワンクリック）
  async function copyPrompt(task) {
    const ok = await copyToClipboard(buildAiPrompt(task))
    if (ok) {
      setCopiedId(task.id)
      setTimeout(() => setCopiedId(c => (c === task.id ? null : c)), 1500)
    } else {
      setError('コピーに失敗しました。ブラウザの権限を確認してください')
    }
  }

  // ドラッグ&ドロップでカラム移動
  function onDropToColumn(status) {
    const id = draggingId
    setDraggingId(null); setDragOverCol(null)
    if (id) moveTask(id, status)
  }

  const filteredTasks = filterAssignee === 'all'
    ? tasks
    : tasks.filter(t => (t.assignee || 'human') === filterAssignee)

  const byStatus = (key) =>
    filteredTasks
      .filter(t => normalizeStatus(t) === key)
      .sort((a, b) => {
        const pOrder = { high: 0, medium: 1, low: 2 }
        const pd = (pOrder[a.priority] || 1) - (pOrder[b.priority] || 1)
        return pd !== 0 ? pd : new Date(a.deadline) - new Date(b.deadline)
      })

  const totalActive = filteredTasks.filter(t => normalizeStatus(t) !== 'done').length

  const selectStyle = {
    padding: '8px 12px', fontSize: 14,
    border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none', background: '#fff',
  }
  // 編集フォーム用のコンパクトなスタイル
  const editLabel = { fontSize: 10, fontWeight: 700, color: '#718096' }
  const editInput = {
    padding: '6px 8px', fontSize: 13, border: '1px solid #CBD5E0',
    borderRadius: 6, outline: 'none', width: '100%', boxSizing: 'border-box', background: '#fff',
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F0F2F5', fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif', color: '#1A202C' }}>

      {/* ヘッダー */}
      <div style={{ background: '#1A202C', color: '#fff', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>📅 締め切り管理</span>
          <span style={{ fontSize: 12, background: '#3182CE', color: '#fff', borderRadius: 20, padding: '2px 10px', fontWeight: 700 }}>
            未完了 {totalActive}件
          </span>
          <span style={{
            fontSize: 11, fontWeight: 700,
            background: connError ? '#FFF5F5' : '#C6F6D5',
            color: connError ? '#C53030' : '#22543D',
            border: `1px solid ${connError ? '#FC8181' : '#38A169'}`,
            borderRadius: 20, padding: '2px 10px',
          }}>
            {connError ? '🔴 Obsidian未接続' : '🟢 Obsidian連携中'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* ビュー切替（カンバン / カレンダー） */}
          <div style={{ display: 'flex', background: '#2D3748', borderRadius: 8, padding: 2 }}>
            {[['kanban', '🗂 カンバン'], ['calendar', '📆 カレンダー']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                style={{
                  background: view === k ? '#3182CE' : 'transparent',
                  color: view === k ? '#fff' : '#A0AEC0',
                  border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', fontWeight: 700,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={enableNotifications}
            title={notifyOn ? '締切リマインド通知: 有効' : 'クリックして締切リマインド通知を有効化'}
            style={{ background: notifyOn ? '#22543D' : '#2D3748', color: notifyOn ? '#9AE6B4' : '#A0AEC0', border: 'none', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' }}
          >
            {notifyOn ? '🔔 通知ON' : '🔕 通知OFF'}
          </button>
          <button
            onClick={() => fetchTasks()}
            style={{ background: '#2D3748', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' }}
          >
            ↺ 更新
          </button>
          <button
            onClick={() => { localStorage.removeItem(API_KEY_STORAGE); setApiKey('') }}
            style={{ background: '#2D3748', color: '#A0AEC0', border: 'none', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' }}
          >
            ⚙
          </button>
          <button
            onClick={() => setShowForm(v => !v)}
            style={{ background: '#3182CE', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          >
            ＋ タスク追加
          </button>
        </div>
      </div>

      {/* 接続エラーバナー */}
      {connError && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FC8181', padding: '10px 24px', fontSize: 13, color: '#C53030', display: 'flex', alignItems: 'center', gap: 8 }}>
          ⚠️ Obsidianに接続できません。Obsidianが起動中でLocal REST APIプラグインが有効か確認してください。
          <button onClick={() => fetchTasks()} style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', background: '#FED7D7', border: '1px solid #FC8181', borderRadius: 6, cursor: 'pointer', color: '#C53030', fontWeight: 700 }}>再接続</button>
        </div>
      )}

      {/* アサインフィルター */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E2E8F0', padding: '8px 24px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#718096', fontWeight: 600, marginRight: 4 }}>フィルター:</span>
        {[['all', 'すべて', '#4A5568', '#EDF2F7'], ...Object.entries(ASSIGNEES).map(([k, v]) => [k, v.label, v.color, v.bg])].map(([key, label, color, bg]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              fontSize: 12, padding: '3px 12px', borderRadius: 20, cursor: 'pointer', fontWeight: 700,
              border: `1px solid ${color}`,
              background: filterAssignee === key ? color : '#fff',
              color: filterAssignee === key ? '#fff' : color,
              transition: 'all 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 追加フォーム */}
      {showForm && (
        <div style={{ background: '#fff', borderBottom: '1px solid #E2E8F0', padding: '16px 24px' }}>
          <form onSubmit={addTask} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>タスク名</label>
              <input
                style={{ padding: '8px 12px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none' }}
                placeholder="例: レポート提出"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>締切日</label>
              <input
                type="date"
                style={{ padding: '8px 12px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none' }}
                value={deadline}
                onChange={e => setDeadline(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>担当者</label>
              <select style={selectStyle} value={assignee} onChange={e => setAssignee(e.target.value)}>
                {Object.entries(ASSIGNEES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>優先度</label>
              <select style={selectStyle} value={priority} onChange={e => setPriority(e.target.value)}>
                {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 280px' }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>AIへの指示 / メモ（任意）</label>
              <input
                style={{ padding: '8px 12px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none' }}
                placeholder="例: [[英語の勉強.md]] を参考にして課題を作成"
                value={aiContext}
                onChange={e => setAiContext(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>タグ（任意・カンマ区切り）</label>
              <input
                style={{ padding: '8px 12px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none' }}
                placeholder="例: 課題, 英語"
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
              <label style={{ fontSize: 12, color: '#718096', fontWeight: 600 }}>参照ノート（任意・カンマ区切り）</label>
              <input
                style={{ padding: '8px 12px', fontSize: 14, border: '1px solid #CBD5E0', borderRadius: 8, outline: 'none' }}
                placeholder="例: 英語の勉強.md, 課題メモ.md"
                value={sourcesInput}
                onChange={e => setSourcesInput(e.target.value)}
              />
            </div>
            <button
              disabled={isColumnFull('todo')}
              title={isColumnFull('todo') ? `To Do は上限 ${COLUMN_LIMIT.todo} 件です` : undefined}
              style={{ padding: '8px 20px', fontWeight: 700, fontSize: 14, background: isColumnFull('todo') ? '#A0AEC0' : '#3182CE', color: '#fff', border: 'none', borderRadius: 8, cursor: isColumnFull('todo') ? 'not-allowed' : 'pointer', height: 38 }}
              type="submit"
            >
              追加
            </button>
            {isColumnFull('todo') && !error && (
              <p style={{ color: '#C53030', fontSize: 13, width: '100%', margin: 0 }}>
                To Do が上限 {COLUMN_LIMIT.todo} 件に達しています。タスクを In Progress / Done に移してから追加してください。
              </p>
            )}
            {error && <p style={{ color: '#E53E3E', fontSize: 13, width: '100%', margin: 0 }}>{error}</p>}
          </form>
        </div>
      )}

      {/* ボード（カンバン / カレンダー） */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#A0AEC0', padding: 40 }}>読み込み中...</p>
      ) : view === 'calendar' ? (
        <CalendarBoard tasks={filteredTasks} onSelect={t => { setView('kanban'); setExpandedId(t.id) }} />
      ) : (
        <div style={{ display: 'flex', gap: 16, padding: 24, overflowX: 'auto', alignItems: 'flex-start' }}>
          {COLUMNS.map(col => {
            const colTasks = byStatus(col.key)
            const fullCount = countByStatus(col.key)      // フィルター無視の実件数
            const limit = COLUMN_LIMIT[col.key]
            const colFull = limit != null && fullCount >= limit
            return (
              <div key={col.key} style={{ flex: '1 1 300px', minWidth: 280, background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '2px solid ' + (colFull ? '#E53E3E' : col.color), display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: col.color }}>{col.label}</span>
                  <span
                    title={limit != null ? `上限 ${limit} 件` : undefined}
                    style={{
                      fontSize: 12, fontWeight: 700, borderRadius: 20, padding: '2px 10px',
                      background: colFull ? '#FFF5F5' : col.bg,
                      color: colFull ? '#C53030' : col.color,
                      border: '1px solid ' + (colFull ? '#FC8181' : col.color),
                    }}
                  >
                    {limit != null ? `${fullCount} / ${limit}` : fullCount}{colFull ? ' 満杯' : ''}
                  </span>
                </div>

                <div
                  onDragOver={e => { if (draggingId) { e.preventDefault(); if (dragOverCol !== col.key) setDragOverCol(col.key) } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverCol(c => (c === col.key ? null : c)) }}
                  onDrop={e => { e.preventDefault(); onDropToColumn(col.key) }}
                  style={{
                    padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 60,
                    background: dragOverCol === col.key ? (colFull ? '#FFF5F5' : '#EBF8FF') : 'transparent',
                    outline: dragOverCol === col.key ? `2px dashed ${colFull ? '#FC8181' : '#3182CE'}` : 'none',
                    outlineOffset: -4, transition: 'background 0.1s',
                  }}
                >
                  {colTasks.length === 0 && (
                    <p style={{ textAlign: 'center', color: '#CBD5E0', fontSize: 13, margin: '12px 0' }}>
                      {dragOverCol === col.key ? (colFull ? '満杯です' : 'ここにドロップ') : 'なし'}
                    </p>
                  )}
                  {colTasks.map(task => {
                    const days = daysLeft(task.deadline)
                    const isDone = col.key === 'done'
                    const asgn = ASSIGNEES[task.assignee] || ASSIGNEES['human']
                    const prio = PRIORITIES[task.priority] || PRIORITIES['medium']
                    const isExpanded = expandedId === task.id
                    const isEditing = editingId === task.id
                    const sources = Array.isArray(task.sources) ? task.sources : []
                    const hasDetail = !!(task.ai_context || sources.length || task.memo)

                    const isDragging = draggingId === task.id
                    return (
                      <div
                        key={task.id}
                        draggable={!isEditing}
                        onDragStart={e => { setDraggingId(task.id); e.dataTransfer.effectAllowed = 'move' }}
                        onDragEnd={() => { setDraggingId(null); setDragOverCol(null) }}
                        onClick={() => !isEditing && hasDetail && setExpandedId(isExpanded ? null : task.id)}
                        style={{
                          background: isDone ? '#F7FAFC' : '#FAFAFA',
                          border: isExpanded ? `1px solid ${asgn.color}` : '1px solid #E2E8F0',
                          borderLeft: `4px solid ${asgn.color}`,
                          borderRadius: 8,
                          padding: '10px 12px',
                          opacity: isDragging ? 0.4 : (isDone ? 0.75 : 1),
                          cursor: isEditing ? 'default' : 'grab',
                          boxShadow: isExpanded ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                          transition: 'box-shadow 0.15s, border-color 0.15s, opacity 0.1s',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 6 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, textDecoration: isDone ? 'line-through' : 'none', color: isDone ? '#A0AEC0' : '#1A202C', flex: 1 }}>
                            {task.title}
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: prio.color, border: `1px solid ${prio.color}`, borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                            {prio.label}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, background: asgn.bg, color: asgn.color, border: `1px solid ${asgn.color}`, borderRadius: 20, padding: '1px 8px', fontWeight: 700 }}>
                            {asgn.label}
                          </span>
                          <span style={{ fontSize: 11, background: urgencyColor(days), color: '#fff', borderRadius: 20, padding: '1px 8px', fontWeight: 700 }}>
                            {urgencyLabel(days)}
                          </span>
                          <span style={{ fontSize: 11, color: '#A0AEC0', marginLeft: 'auto' }}>{task.deadline}</span>
                        </div>

                        {/* AI担当タスク: 指示をワンクリックでコピー（ビューを開かず貼り付け用にコピー） */}
                        {isAiAssignee(task.assignee) && !isEditing && (
                          <button
                            onClick={e => { e.stopPropagation(); copyPrompt(task) }}
                            title="AIへの指示をクリップボードにコピー"
                            style={{
                              width: '100%', marginBottom: 6, fontSize: 12, fontWeight: 700,
                              padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                              border: `1px solid ${copiedId === task.id ? '#38A169' : asgn.color}`,
                              background: copiedId === task.id ? '#F0FFF4' : asgn.bg,
                              color: copiedId === task.id ? '#22543D' : asgn.color,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                            }}
                          >
                            {copiedId === task.id ? '✓ コピーしました' : `📋 ${asgn.label}への指示をコピー`}
                          </button>
                        )}

                        {hasDetail && !isExpanded && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#718096', background: '#F7FAFC', border: '1px solid #E2E8F0', borderRadius: 6, padding: '4px 8px', marginBottom: 6 }}>
                            <span style={{ fontStyle: 'italic', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {task.ai_context || task.memo || 'タップで詳細を表示'}
                            </span>
                            <span style={{ fontWeight: 700, color: asgn.color, whiteSpace: 'nowrap' }}>詳細 ▾</span>
                          </div>
                        )}

                        {isEditing && draft && (
                          <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', border: `1px solid ${asgn.color}`, borderRadius: 8, padding: 10 }} onClick={e => e.stopPropagation()}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: asgn.color }}>タスクを編集</div>
                            <label style={editLabel}>タスク名</label>
                            <input style={editInput} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 120px' }}>
                                <label style={editLabel}>締切日</label>
                                <input type="date" style={editInput} value={draft.deadline} onChange={e => setDraft({ ...draft, deadline: e.target.value })} />
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 100px' }}>
                                <label style={editLabel}>担当者</label>
                                <select style={editInput} value={draft.assignee} onChange={e => setDraft({ ...draft, assignee: e.target.value })}>
                                  {Object.entries(ASSIGNEES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                                </select>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 80px' }}>
                                <label style={editLabel}>優先度</label>
                                <select style={editInput} value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })}>
                                  {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                                </select>
                              </div>
                            </div>
                            <label style={editLabel}>AIへの指示</label>
                            <input style={editInput} value={draft.ai_context} onChange={e => setDraft({ ...draft, ai_context: e.target.value })} />
                            <label style={editLabel}>タグ（カンマ区切り）</label>
                            <input style={editInput} value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} placeholder="例: 課題, 英語" />
                            <label style={editLabel}>参照ノート（カンマ区切り）</label>
                            <input style={editInput} value={draft.sources} onChange={e => setDraft({ ...draft, sources: e.target.value })} placeholder="例: 英語の勉強.md" />
                            <label style={editLabel}>メモ本文</label>
                            <textarea style={{ ...editInput, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} value={draft.memo} onChange={e => setDraft({ ...draft, memo: e.target.value })} />
                            {error && <p style={{ color: '#E53E3E', fontSize: 12, margin: 0 }}>{error}</p>}
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button onClick={cancelEdit} style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #CBD5E0', borderRadius: 6, background: '#fff', color: '#718096', cursor: 'pointer', fontWeight: 600 }}>キャンセル</button>
                              <button onClick={() => saveEdit(task)} style={{ fontSize: 12, padding: '5px 14px', border: 'none', borderRadius: 6, background: '#3182CE', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>保存</button>
                            </div>
                          </div>
                        )}

                        {isExpanded && !isEditing && (
                          <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }} onClick={e => e.stopPropagation()}>
                            {task.ai_context && (
                              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: asgn.color, marginBottom: 4, letterSpacing: 0.3 }}>AIへの指示</div>
                                <div style={{ fontSize: 12, color: '#2D3748', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{task.ai_context}</div>
                              </div>
                            )}
                            {sources.length > 0 && (
                              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: '#4A5568', marginBottom: 6 }}>参照ノート（{sources.length}）</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {sources.map((src, i) => (
                                    <a key={i} href={obsidianUri(src)} title={`Obsidian で開く: ${src}`}
                                      style={{ fontSize: 11, fontFamily: 'monospace', color: '#2B6CB0', background: '#EBF8FF', border: '1px solid #BEE3F8', borderRadius: 4, padding: '3px 8px', textDecoration: 'none', wordBreak: 'break-all' }}>
                                      🔗 {sourceLabel(src)}
                                    </a>
                                  ))}
                                </div>
                                <div style={{ fontSize: 10, color: '#A0AEC0', marginTop: 6 }}>クリックするとObsidianで開きます</div>
                              </div>
                            )}
                            {task.memo && (
                              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: '#4A5568', marginBottom: 4 }}>メモ本文</div>
                                <div style={{ fontSize: 12, color: '#4A5568', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{task.memo}</div>
                              </div>
                            )}
                            <div style={{ fontSize: 10, color: '#A0AEC0', textAlign: 'right', marginTop: 4, cursor: 'pointer' }} onClick={() => setExpandedId(null)}>閉じる ▴</div>
                          </div>
                        )}

                        {!isEditing && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                          {COLUMNS.filter(c => c.key !== col.key).map(c => {
                            const targetFull = isColumnFull(c.key)
                            return (
                              <button
                                key={c.key}
                                onClick={() => moveTask(task.id, c.key)}
                                disabled={targetFull}
                                title={targetFull ? `${c.label} は上限 ${COLUMN_LIMIT[c.key]} 件に達しています` : undefined}
                                style={{
                                  fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600,
                                  border: '1px solid ' + (targetFull ? '#E2E8F0' : c.color),
                                  background: '#fff',
                                  color: targetFull ? '#CBD5E0' : c.color,
                                  cursor: targetFull ? 'not-allowed' : 'pointer',
                                }}
                              >
                                → {c.label}{targetFull ? '（満杯）' : ''}
                              </button>
                            )
                          })}
                          <button
                            onClick={() => startEdit(task)}
                            style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${asgn.color}`, borderRadius: 6, background: '#fff', color: asgn.color, cursor: 'pointer', fontWeight: 600, marginLeft: 'auto' }}
                          >
                            ✎ 編集
                          </button>
                          <button
                            onClick={() => removeTask(task.id)}
                            style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', color: '#A0AEC0', cursor: 'pointer' }}
                          >
                            削除
                          </button>
                        </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
