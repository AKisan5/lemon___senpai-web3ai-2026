import { useState, useEffect } from 'react'

const API = 'http://localhost:3001'

const COLUMNS = [
  { key: 'todo',        label: 'To Do',      color: '#718096', bg: '#F7FAFC' },
  { key: 'in_progress', label: 'In Progress', color: '#3182CE', bg: '#EBF8FF' },
  { key: 'done',        label: 'Done',        color: '#38A169', bg: '#F0FFF4' },
]

function daysLeft(deadline) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.ceil((new Date(deadline) - today) / 86400000)
}
function urgencyColor(days) {
  if (days < 0)  return '#718096'
  if (days === 0) return '#E53E3E'
  if (days <= 2)  return '#DD6B20'
  if (days <= 7)  return '#D69E2E'
  return '#38A169'
}
function urgencyLabel(days) {
  if (days < 0)  return `${Math.abs(days)}日超過`
  if (days === 0) return '今日締切！'
  if (days === 1) return '明日締切'
  return `あと${days}日`
}

function normalizeStatus(task) {
  if (task.status) return task.status
  return task.done ? 'done' : 'todo'
}

export default function App() {
  const [tasks, setTasks]       = useState([])
  const [title, setTitle]       = useState('')
  const [deadline, setDeadline] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // サーバーに繋がっているかどうか（自分のPCでのみ true になる）
  const [connected, setConnected] = useState(false)

  async function fetchTasks() {
    try {
      const res = await fetch(`${API}/tasks`)
      if (res.ok) {
        setTasks(await res.json())
        setConnected(true)
      }
    } catch {
      // ローカルサーバー未起動 = タスクなし（エラー表示しない）
      setTasks([])
      setConnected(false)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchTasks() }, [])

  async function addTask(e) {
    e.preventDefault()
    if (!title.trim()) { setError('タスク名を入力してください'); return }
    if (!deadline)     { setError('締切日を選んでください'); return }
    const res = await fetch(`${API}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), deadline }),
    })
    if (res.ok) { setTasks(await res.json()); setTitle(''); setDeadline(''); setError(''); setShowForm(false) }
  }

  async function moveTask(id, status) {
    const res = await fetch(`${API}/tasks/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) setTasks(await res.json())
  }

  async function removeTask(id) {
    const res = await fetch(`${API}/tasks/${id}`, { method: 'DELETE' })
    if (res.ok) setTasks(await res.json())
  }

  const byStatus = (key) =>
    tasks
      .filter(t => normalizeStatus(t) === key)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))

  const totalActive = tasks.filter(t => normalizeStatus(t) !== 'done').length

  return (
    <div style={{ minHeight: '100vh', background: '#F0F2F5', fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif', color: '#1A202C' }}>

      {/* ヘッダー */}
      <div style={{ background: '#1A202C', color: '#fff', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>📅 締め切り管理</span>
          {connected && (
            <span style={{ fontSize: 12, background: '#3182CE', color: '#fff', borderRadius: 20, padding: '2px 10px', fontWeight: 700 }}>
              未完了 {totalActive}件
            </span>
          )}
        </div>
        {connected && (
          <button
            onClick={() => setShowForm(v => !v)}
            style={{ background: '#3182CE', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          >
            ＋ タスク追加
          </button>
        )}
      </div>

      {/* 追加フォーム（折りたたみ） */}
      {showForm && connected && (
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
            <button style={{ padding: '8px 20px', fontWeight: 700, fontSize: 14, background: '#3182CE', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', height: 38 }} type="submit">
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
              <div key={col.key} style={{ flex: '1 1 280px', minWidth: 260, background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                {/* 列ヘッダー */}
                <div style={{ padding: '12px 16px', borderBottom: '2px solid ' + col.color, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: col.color }}>{col.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, background: col.bg, color: col.color, borderRadius: 20, padding: '2px 10px', border: '1px solid ' + col.color }}>
                    {colTasks.length}
                  </span>
                </div>

                {/* タスクカード */}
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 60 }}>
                  <p style={{ textAlign: 'center', color: '#CBD5E0', fontSize: 13, margin: '12px 0' }}>
                    {colTasks.length === 0 ? 'なし' : ''}
                  </p>
                  {colTasks.map(task => {
                    const days = daysLeft(task.deadline)
                    const isDone = col.key === 'done'
                    return (
                      <div key={task.id} style={{
                        background: isDone ? '#F7FAFC' : '#FAFAFA',
                        border: '1px solid #E2E8F0',
                        borderLeft: `4px solid ${urgencyColor(days)}`,
                        borderRadius: 8,
                        padding: '10px 12px',
                        opacity: isDone ? 0.75 : 1,
                      }}>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, textDecoration: isDone ? 'line-through' : 'none', color: isDone ? '#A0AEC0' : '#1A202C' }}>
                          {task.title}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontSize: 11, background: urgencyColor(days), color: '#fff', borderRadius: 20, padding: '1px 8px', fontWeight: 700 }}>
                            {urgencyLabel(days)}
                          </span>
                          <span style={{ fontSize: 11, color: '#A0AEC0' }}>{task.deadline}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
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
