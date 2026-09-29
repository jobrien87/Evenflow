import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, SectionHeader, EmptyState } from '../ui';

const TASK_TYPES = ['FOLLOW_UP', 'CALLBACK', 'APPOINTMENT', 'MANAGER', 'TRAINING', 'WINBACK', 'CROSS_SELL'];

function isOverdue(task) {
  return task.dueAt && new Date(task.dueAt).getTime() < Date.now();
}
function isDueToday(task) {
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt);
  const now = new Date();
  return due.toDateString() === now.toDateString() && !isOverdue(task);
}

// Every role gets the same real task list here — due-today/overdue/
// upcoming, grouped client-side from the one already-working GET /tasks
// (already correctly agency/producer/TM-scoped server-side).
export default function TasksPanel() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [assignments, setAssignments] = useState(null);
  const [agencyId, setAgencyId] = useState('');
  const [form, setForm] = useState({ type: 'FOLLOW_UP', title: '', dueAt: '' });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
    if (user?.role === 'TELEMARKETER') loadAssignments();
  }, [user?.role]);

  async function load() {
    setError('');
    try {
      const data = await api.tasks();
      setTasks(data.tasks);
    } catch (err) {
      setError(err.data?.message || 'Could not load tasks. Try refreshing.');
    }
  }

  async function loadAssignments() {
    try {
      const data = await api.myAssignments();
      setAssignments(data.assignments);
      if (data.assignments.length === 1) setAgencyId(data.assignments[0].agency.id);
    } catch {
      // Falls through to the create form's own "no agency" guard below.
    }
  }

  async function createTask(e) {
    e.preventDefault();
    setFormError('');
    if (!form.title.trim()) return;
    if (user.role === 'TELEMARKETER' && !agencyId) {
      setFormError('Pick which agency this task is for.');
      return;
    }
    setBusy(true);
    try {
      await api.createTask({
        type: form.type,
        title: form.title.trim(),
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        assignedToId: user.id,
        ...(user.role === 'TELEMARKETER' ? { agencyId } : {}),
      });
      setForm({ type: 'FOLLOW_UP', title: '', dueAt: '' });
      setShowNew(false);
      await load();
    } catch (err) {
      setFormError(err.data?.message || 'Could not create that task.');
    } finally {
      setBusy(false);
    }
  }

  async function markDone(taskId) {
    await api.completeTask(taskId, { status: 'COMPLETED' });
    await load();
  }

  const open = tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const overdue = open.filter(isOverdue);
  const dueToday = open.filter(isDueToday);
  const upcoming = open.filter((t) => !isOverdue(t) && !isDueToday(t));

  const noAgencyForTM = user?.role === 'TELEMARKETER' && assignments && assignments.length === 0;

  return (
    <div style={s.wrap}>
      {error && (
        <div style={s.loadErrorBox}>
          {error}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <section style={s.section}>
        <div style={s.headerRow}>
          <SectionHeader>Tasks ({open.length})</SectionHeader>
          {user?.role !== 'PLATFORM_OWNER' && (
            <Button variant="primary" size="sm" onClick={() => setShowNew(!showNew)}>+ NEW TASK</Button>
          )}
        </div>

        {showNew && (
          <Card style={s.formCard}>
            <form onSubmit={createTask} style={s.form}>
              {noAgencyForTM && (
                <div style={s.error}>You're not assigned to any agency right now, so a task has nowhere to belong.</div>
              )}
              {user?.role === 'TELEMARKETER' && assignments && assignments.length > 1 && (
                <select style={s.input} value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
                  <option value="">Select agency…</option>
                  {assignments.map((a) => <option key={a.agency.id} value={a.agency.id}>{a.agency.name}</option>)}
                </select>
              )}
              <select style={s.input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              <input style={s.input} placeholder="Task title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              <input style={s.input} type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
              {formError && <div style={s.error}>{formError}</div>}
              <Button variant="primary" type="submit" disabled={busy || noAgencyForTM}>{busy ? 'CREATING…' : 'CREATE TASK'}</Button>
            </form>
          </Card>
        )}
      </section>

      <TaskGroup title="Overdue" tasks={overdue} tone="danger" onDone={markDone} />
      <TaskGroup title="Due Today" tasks={dueToday} tone="warning" onDone={markDone} />
      <TaskGroup title="Upcoming / No Due Date" tasks={upcoming} tone="neutral" onDone={markDone} />

      {open.length === 0 && !error && (
        <EmptyState title="Nothing on your plate" description="No open tasks right now." />
      )}
    </div>
  );
}

function TaskGroup({ title, tasks, tone, onDone }) {
  if (tasks.length === 0) return null;
  return (
    <section style={s.section}>
      <div style={s.groupTitle}>{title.toUpperCase()} ({tasks.length})</div>
      <Card style={s.listCard}>
        {tasks.map((t) => (
          <div key={t.id} style={s.taskRow}>
            <div>
              <div style={s.taskTitle}>{t.title}</div>
              <div style={s.taskSub}>
                {t.type.replace(/_/g, ' ')}
                {t.lead?.customer ? ` · ${t.lead.customer.firstName} ${t.lead.customer.lastName}` : ''}
                {t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleString()}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge tone={tone}>{t.status.replace(/_/g, ' ')}</Badge>
              <Button variant="secondary" size="sm" onClick={() => onDone(t.id)}>MARK DONE</Button>
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 24 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  formCard: { marginTop: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12 },
  groupTitle: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 8 },
  listCard: { padding: 0, overflow: 'hidden' },
  taskRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)' },
  taskTitle: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
  taskSub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
};
