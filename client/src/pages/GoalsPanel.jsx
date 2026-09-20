import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const METRICS = ['sales', 'quotes', 'calls', 'contacts', 'cross_sells', 'winbacks', 'transfers'];

export default function GoalsPanel() {
  const [goals, setGoals] = useState([]);
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ userId: '', metric: 'sales', targetValue: '', periodType: 'monthly', periodStart: '', periodEnd: '' });
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [goalData, userData] = await Promise.all([api.goals(), api.users('')]);
    setGoals(goalData.goals);
    setUsers(userData.users.filter((u) => u.role === 'PRODUCER'));
  }

  function defaultMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  function openForm() {
    const range = defaultMonthRange();
    setForm({ userId: '', metric: 'sales', targetValue: '', periodType: 'monthly', periodStart: range.start, periodEnd: range.end });
    setShowForm(true);
  }

  async function submit(e) {
    e.preventDefault();
    setStatus('Saving…');
    try {
      await api.createGoal({
        userId: form.userId || undefined,
        metric: form.metric,
        targetValue: parseInt(form.targetValue, 10),
        periodType: form.periodType,
        periodStart: new Date(form.periodStart).toISOString(),
        periodEnd: new Date(form.periodEnd).toISOString(),
      });
      setStatus('Goal set.');
      setShowForm(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to set goal.');
    }
  }

  async function remove(id) {
    if (!confirm('Delete this goal?')) return;
    await api.deleteGoal(id);
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>GOALS ({goals.length})</h3>
        <button style={s.smallButton} onClick={openForm}>+ SET GOAL</button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={s.form}>
          <select style={s.input} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
            <option value="">Whole agency (no specific producer)</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
          </select>
          <select style={s.input} value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
            {METRICS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
          <input style={s.input} type="number" min="1" placeholder="Target value" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} required />
          <select style={s.input} value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value })}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="quarterly">Quarterly</option>
            <option value="custom">Custom</option>
          </select>
          <div style={s.dateRow}>
            <input style={s.input} type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} required />
            <input style={s.input} type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required />
          </div>
          <button style={s.submitButton} type="submit">Set Goal</button>
          {status && <div style={s.status}>{status}</div>}
        </form>
      )}

      {goals.map((g) => (
        <div key={g.id} style={s.row} className="ui-row-stack">
          <div>
            <div style={s.rowTitle}>{g.userId ? users.find((u) => u.id === g.userId)?.firstName || 'Producer' : 'Agency-wide'} — {g.metric.replace('_', ' ')}</div>
            <div style={s.rowSub}>Target {g.targetValue} · {new Date(g.periodStart).toLocaleDateString()} – {new Date(g.periodEnd).toLocaleDateString()}</div>
          </div>
          <button style={s.deleteButton} onClick={() => remove(g.id)}>DELETE</button>
        </div>
      ))}
      {goals.length === 0 && <div style={s.empty}>No goals set yet — producer pace tracking has nothing to compare against until one is.</div>}
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' },
  dateRow: { display: 'flex', gap: 8 },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', fontSize: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  deleteButton: { fontSize: 10, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
