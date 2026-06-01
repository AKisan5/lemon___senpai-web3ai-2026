import { useState, useEffect } from 'react'

const STORAGE_KEY = 'deadline-tasks'

function daysLeft(deadline) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(deadline)
  return Math.ceil((d - today) / (1000 * 60 * 60 * 24))
}

function urgencyColor(days) {
  if (days < 0) return '#888'
  if (days === 0) return '#e53e3e'
  if (days <= 2) return '#dd6b20'
  if (days <= 7) return '#d69e2e'
  return '#38a169'
}

function urgencyLabel(days) {
  if (days < 0) return `${Math.abs(days)}日超過`
  if (days === 0) return '今日が締切！'
  if (days === 1) return '明日締切'
  return `あと${days}日`
}

export default function App() {
  const [tasks, setTasks] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? []
    } catch {
      return []
    }
  })
  const [title, setTitle] = useState('')
  const [deadline, setDeadline] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

  const sorted = [...tasks].sort((a, b) => new Date(a.deadline) - new Date(b.deadline))

  function addTask(e) {
    e.preventDefault()
    if (!title.trim()) { setError('タスク名を入力してください'); return }
    if (!deadline) { setError('締切日を選んでください'); return }
    setTasks(prev => [...prev, { id: crypto.randomUUID(), title: title.trim(), deadline }])
    setTitle('')
    setDeadline('')
    setError('')
  }

  function removeTask(id) {
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  const styles = {
    app: {
      maxWidth: 480,
      margin: '0 auto',
      padding: '24px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif',
      color: '#1a202c',
    },
    heading: { fontSize: 22, fontWeight: 700, marginBottom: 20 },
    form: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      marginBottom: 24,
      background: '#f7fafc',
      padding: 16,
      borderRadius: 10,
    },
    input: {
      padding: '10px 12px',
      fontSize: 15,
      border: '1px solid #cbd5e0',
      borderRadius: 8,
      outline: 'none',
    },
    btn: {
      padding: '10px',
      fontSize: 15,
      fontWeight: 600,
      background: '#3182ce',
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      cursor: 'pointer',
    },
    error: { color: '#e53e3e', fontSize: 13 },
    list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
    item: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 14px',
      border: '1px solid #e2e8f0',
      borderRadius: 10,
      background: '#fff',
    },
    badge: (days) => ({
      fontSize: 12,
      fontWeight: 700,
      color: '#fff',
      background: urgencyColor(days),
      borderRadius: 20,
      padding: '2px 10px',
      whiteSpace: 'nowrap',
    }),
    deleteBtn: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontSize: 18,
      color: '#a0aec0',
      lineHeight: 1,
      padding: '0 4px',
    },
    empty: { textAlign: 'center', color: '#a0aec0', marginTop: 32 },
  }

  return (
    <div style={styles.app}>
      <h1 style={styles.heading}>📅 締め切り管理</h1>

      <form style={styles.form} onSubmit={addTask}>
        <input
          style={styles.input}
          placeholder="タスク名"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
        <input
          style={styles.input}
          type="date"
          value={deadline}
          onChange={e => setDeadline(e.target.value)}
        />
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.btn} type="submit">追加</button>
      </form>

      {sorted.length === 0 ? (
        <p style={styles.empty}>タスクがありません</p>
      ) : (
        <ul style={styles.list}>
          {sorted.map(task => {
            const days = daysLeft(task.deadline)
            return (
              <li key={task.id} style={styles.item}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{task.title}</div>
                  <div style={{ fontSize: 12, color: '#718096' }}>{task.deadline}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={styles.badge(days)}>{urgencyLabel(days)}</span>
                  <button style={styles.deleteBtn} onClick={() => removeTask(task.id)} title="削除">×</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
