import { useState, useEffect, useCallback } from 'react'

const OBSIDIAN_API = 'http://localhost:27123'
const TASKS_PATH = 'Tasks'
const API_KEY_STORAGE = 'obsidian-local-rest-api-key'

const COLUMNS = [
  { key: 'todo',        label: 'To Do',      color: '#718096', bg: '#F7FAFC' },
  { key: 'in_progress', label: 'In Progress', color: '#3182CE', bg: '#EBF8FF' },
  { key: 'done',        label: 'Done',        color: '#38A169', bg: '#F0FFF4' },
]

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
  const aiCtx = (task.ai_context || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  return `---
id: ${task.id}
title: ${task.title}
deadline: ${task.deadline}
status: ${task.status}
assignee: ${task.assignee}
priority: ${task.priority}
ai_context: "${aiCtx}"${tags}
created: ${task.created || today}
updated: ${today}
---

## メモ

${task.memo || ''}
`
}

// ─── Obsidian Local REST API helpers ─────────────────────────────────────
function obsFetch(path, apiKey, options = {}) {
  return fetch(`${OBSIDIAN_API}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

// ─── API Key Setup Screen ──────────────────────────────────────────────────
function ApiKeySetup({ onSave }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!key.trim()) { setError('APIキーを入力してください'); return }
    setTesting(true)
    setError('')
    try {
      const res = await obsFetch(`vault/${TASKS_PATH}/`, key.trim())
      if (res.ok || res.status === 404) {
        localStorage.setItem(API_KEY_STORAGE, key.trim())
        onSave(key.trim())
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

// ─── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey]       = useState(() => localStorage.getItem(API_KEY_STORAGE) || '')
  const [tasks, setTasks]         = useState([])
  const [title, setTitle]         = useState('')
  const [deadline, setDeadline]   = useState('')
  const [assignee, setAssignee]   = useState('human')
  const [priority, setPriority]   = useState('medium')
  const [aiContext, setAiContext]  = useState('')
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [filterAssignee, setFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)
  const [connError, setConnError] = useState(false)

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

  if (!apiKey) {
    return <ApiKeySetup onSave={key => { setApiKey(key); fetchTasks(key) }} />
  }

  async function addTask(e) {
    e.preventDefault()
    if (!title.trim()) { setError('タスク名を入力してください'); return }
    if (!deadline)     { setError('締切日を選んでください'); return }

    const id = `task_${Date.now()}`
    const newTask = {
      id,
      title: title.trim(),
      deadline,
      status: 'todo',
      assignee,
      priority,
      ai_context: aiContext,
      tags: [],
      memo: '',
      created: new Date().toISOString().split('T')[0],
      _filename: `${id}.md`,
    }

    try {
      await writeTask(apiKey, newTask)
      setTasks(prev => [...prev, newTask])
      setTitle(''); setDeadline(''); setAssignee('human')
      setPriority('medium'); setAiContext('')
      setError(''); setShowForm(false)
    } catch (err) {
      setError('保存に失敗しました: ' + err.message)
    }
  }

  async function moveTask(id, status) {
    const task = tasks.find(t => t.id === id)
    if (!task) return
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
        <div style={{ display: 'flex', gap: 8 }}>
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
            <button
              style={{ padding: '8px 20px', fontWeight: 700, fontSize: 14, background: '#3182CE', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', height: 38 }}
              type="submit"
            >
              追加
            </button>
            {error && <p style={{ color: '#E53E3E', fontSize: 13, width: '100%', margin: 0 }}>{error}</p>}
          </form>
        </div>
      )}

      {/* カンバンボード */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#A0AEC0', padding: 40 }}>読み込み中...</p>
      ) : (
        <div style={{ display: 'flex', gap: 16, padding: 24, overflowX: 'auto', alignItems: 'flex-start' }}>
          {COLUMNS.map(col => {
            const colTasks = byStatus(col.key)
            return (
              <div key={col.key} style={{ flex: '1 1 300px', minWidth: 280, background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '2px solid ' + col.color, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: col.color }}>{col.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, background: col.bg, color: col.color, borderRadius: 20, padding: '2px 10px', border: '1px solid ' + col.color }}>
                    {colTasks.length}
                  </span>
                </div>

                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 60 }}>
                  {colTasks.length === 0 && (
                    <p style={{ textAlign: 'center', color: '#CBD5E0', fontSize: 13, margin: '12px 0' }}>なし</p>
                  )}
                  {colTasks.map(task => {
                    const days = daysLeft(task.deadline)
                    const isDone = col.key === 'done'
                    const asgn = ASSIGNEES[task.assignee] || ASSIGNEES['human']
                    const prio = PRIORITIES[task.priority] || PRIORITIES['medium']
                    const isExpanded = expandedId === task.id
                    const sources = Array.isArray(task.sources) ? task.sources : []
                    const hasDetail = !!(task.ai_context || sources.length || task.memo)

                    return (
                      <div
                        key={task.id}
                        onClick={() => hasDetail && setExpandedId(isExpanded ? null : task.id)}
                        style={{
                          background: isDone ? '#F7FAFC' : '#FAFAFA',
                          border: isExpanded ? `1px solid ${asgn.color}` : '1px solid #E2E8F0',
                          borderLeft: `4px solid ${asgn.color}`,
                          borderRadius: 8,
                          padding: '10px 12px',
                          opacity: isDone ? 0.75 : 1,
                          cursor: hasDetail ? 'pointer' : 'default',
                          boxShadow: isExpanded ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                          transition: 'box-shadow 0.15s, border-color 0.15s',
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

                        {hasDetail && !isExpanded && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#718096', background: '#F7FAFC', border: '1px solid #E2E8F0', borderRadius: 6, padding: '4px 8px', marginBottom: 6 }}>
                            <span style={{ fontStyle: 'italic', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {task.ai_context || task.memo || 'タップで詳細を表示'}
                            </span>
                            <span style={{ fontWeight: 700, color: asgn.color, whiteSpace: 'nowrap' }}>詳細 ▾</span>
                          </div>
                        )}

                        {isExpanded && (
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

                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                          {COLUMNS.filter(c => c.key !== col.key).map(c => (
                            <button
                              key={c.key}
                              onClick={() => moveTask(task.id, c.key)}
                              style={{ fontSize: 11, padding: '2px 8px', border: '1px solid ' + c.color, borderRadius: 6, background: '#fff', color: c.color, cursor: 'pointer', fontWeight: 600 }}
                            >
                              → {c.label}
                            </button>
                          ))}
                          <button
                            onClick={() => removeTask(task.id)}
                            style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', color: '#A0AEC0', cursor: 'pointer', marginLeft: 'auto' }}
                          >
                            削除
                          </button>
                        </div>
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
