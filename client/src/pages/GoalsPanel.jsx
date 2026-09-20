import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ProgressBar } from '../ui';

const METRICS = ['sales', 'quotes', 'calls', 'contacts', 'premium_cents', 'cross_sells', 'winbacks', 'transfers'];

function formatUserName(user) {
  if (!user) return 'Producer';
  return `${user.firstName} ${user.lastName}`;
}

export default function GoalsPanel() {
  const [goals, setGoals] = useState([]);
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ userId: '', metric: 'sales', targetValue: '', periodType: 'monthly', periodStart: '', periodEnd: '' });
  const [status, setStatus] = useState('');
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ targetValue: '', periodStart: '', periodEnd: '' });

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

  function resetFormFields() {
    const range = defaultMonthRange();
    setForm({ userId: '', metric: 'sales', targetValue: '', periodType: 'monthly', periodStart: range.start, periodEnd: range.end });
  }

  function openForm() {
    resetFormFields();
    setAiNote('');
    setShowForm(true);
  }

  async function parseWithAi() {
    if (!aiText.trim()) return;
    setAiBusy(true);
    setAiNote('');
    try {
      const res = await api.parseGoal(aiText.trim());
      if (!res.available) {
        resetFormFields();
        setShowForm(true);
        setAiNote(res.message || 'AI parsing is not configured — use the form below.');
        return;
      }
      const d = res.draft;
      setForm({
        userId: d.userId || '',
        metric: d.metric,
        targetValue: String(d.targetValue),
        periodType: d.periodType,
        periodStart: d.periodStart.slice(0, 10),
        periodEnd: d.periodEnd.slice(0, 10),
      });
      setAiNote(
        d.unmatchedProducerName
          ? `Couldn't match "${d.unmatchedProducerName}" to an active producer — set manually below, or leave as agency-wide.`
          : 'Review the parsed goal below, then Set Goal.'
      );
      setShowForm(true);
      setAiText('');
    } catch (err) {
      resetFormFields();
      setShowForm(true);
      setAiNote(err.data?.message || 'Could not parse that — use the form below.');
    } finally {
      setAiBusy(false);
    }
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
      setAiNote('');
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

  function startEdit(g) {
    setEditingId(g.id);
    setEditForm({
      targetValue: String(g.targetValue),
      periodStart: new Date(g.periodStart).toISOString().slice(0, 10),
      periodEnd: new Date(g.periodEnd).toISOString().slice(0, 10),
    });
  }

  async function saveEdit() {
    await api.updateGoal(editingId, {
      targetValue: parseInt(editForm.targetValue, 10),
      periodStart: new Date(editForm.periodStart).toISOString(),
      periodEnd: new Date(editForm.periodEnd).toISOString(),
    });
    setEditingId(null);
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>GOALS ({goals.length})</h3>
        <button style={s.smallButton} onClick={openForm}>+ SET GOAL</button>
      </div>

      <div style={s.aiBox}>
        <div style={s.aiLabel}>✨ DESCRIBE A GOAL</div>
        <div style={s.aiRow}>
          <input
            style={s.input}
            placeholder='e.g. "get producers to 10 sales this month"'
            value={aiText}
            onChange={(e) => setAiText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && parseWithAi()}
          />
          <button style={s.smallButton} disabled={aiBusy || !aiText.trim()} onClick={parseWithAi}>
            {aiBusy ? 'PARSING…' : 'PARSE'}
          </button>
        </div>
        {aiNote && <div style={s.aiNote}>{aiNote}</div>}
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
        <div key={g.id} style={s.goalCard(g.justCompleted)}>
          {g.justCompleted && <div style={s.celebrationBanner}>🎉 GOAL COMPLETE</div>}
          <div style={s.goalTop} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{g.userId ? formatUserName(users.find((u) => u.id === g.userId)) : 'Agency-wide'} — {g.metric.replace(/_/g, ' ')}</div>
              <div style={s.rowSub}>{new Date(g.periodStart).toLocaleDateString()} – {new Date(g.periodEnd).toLocaleDateString()}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {g.completedAt && !g.justCompleted && <span style={s.completedBadge}>COMPLETED</span>}
              <button style={s.editButton} onClick={() => startEdit(g)}>EDIT</button>
              <button style={s.deleteButton} onClick={() => remove(g.id)}>DELETE</button>
            </div>
          </div>

          {editingId === g.id ? (
            <div style={s.editRow}>
              <input style={s.input} type="number" min="1" value={editForm.targetValue} onChange={(e) => setEditForm({ ...editForm, targetValue: e.target.value })} />
              <input style={s.input} type="date" value={editForm.periodStart} onChange={(e) => setEditForm({ ...editForm, periodStart: e.target.value })} />
              <input style={s.input} type="date" value={editForm.periodEnd} onChange={(e) => setEditForm({ ...editForm, periodEnd: e.target.value })} />
              <button style={s.smallButton} onClick={saveEdit}>SAVE</button>
              <button style={s.editButton} onClick={() => setEditingId(null)}>CANCEL</button>
            </div>
          ) : (
            <div style={s.progressWrap}>
              <div style={s.progressLabel}>
                <span>{g.actual === null ? 'No data yet' : `${g.actual} / ${g.targetValue}`}</span>
                <span>{g.progressPercent === null ? '—' : `${g.progressPercent}%`}</span>
              </div>
              <ProgressBar value={g.actual ?? 0} max={g.targetValue} />
            </div>
          )}
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
  smallButton: { padding: '8px 14px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  aiBox: { background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', borderRadius: 8, padding: 14, marginBottom: 14 },
  aiLabel: { fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: 1, marginBottom: 8 },
  aiRow: { display: 'flex', gap: 8 },
  aiNote: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 8, lineHeight: 1.4 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' },
  dateRow: { display: 'flex', gap: 8 },
  submitButton: { padding: '10px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', fontSize: 12 },
  goalCard: (justCompleted) => ({
    background: 'var(--bg-elevated)',
    border: justCompleted ? '1px solid var(--border-accent)' : '1px solid var(--border-hairline)',
    borderRadius: 8, padding: 14, marginBottom: 10,
    boxShadow: justCompleted ? 'var(--shadow-glow-accent)' : undefined,
  }),
  celebrationBanner: {
    fontSize: 11, fontWeight: 700, letterSpacing: 1, color: 'var(--accent-on)',
    background: 'var(--accent-gradient)', display: 'inline-block', padding: '3px 10px', borderRadius: 4, marginBottom: 10,
  },
  goalTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', textTransform: 'capitalize' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  completedBadge: { fontSize: 10, color: 'var(--accent)', border: '1px solid var(--border-accent)', padding: '4px 8px', borderRadius: 4, alignSelf: 'center' },
  editButton: { fontSize: 10, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  deleteButton: { fontSize: 10, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  editRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  progressWrap: {},
  progressLabel: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
