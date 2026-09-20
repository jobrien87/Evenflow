import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const CATEGORIES = ['general', 'billing', 'technical', 'transfer_issue', 'vendor_issue', 'other'];

export default function SupportPanel() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'general', subject: '', description: '' });
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const data = await api.supportTickets();
    setTickets(data.tickets);
  }

  async function submit(e) {
    e.preventDefault();
    setStatus('Submitting…');
    try {
      await api.createSupportTicket(form);
      setStatus('Ticket created.');
      setForm({ category: 'general', subject: '', description: '' });
      setShowForm(false);
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to create ticket.');
    }
  }

  async function changeStatus(id, newStatus) {
    await api.setSupportTicketStatus(id, newStatus);
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>SUPPORT TICKETS ({tickets.length})</h3>
        <button style={s.smallButton} onClick={() => setShowForm(!showForm)}>+ NEW TICKET</button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={s.form}>
          <select style={s.input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
          <input style={s.input} placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
          <textarea style={{ ...s.input, minHeight: 70 }} placeholder="Describe the issue" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
          <button style={s.submitButton} type="submit">Submit Ticket</button>
        </form>
      )}
      {status && <div style={s.status}>{status}</div>}

      {tickets.map((t) => (
        <div key={t.id} style={s.row} className="ui-row-stack">
          <div style={{ flex: 1 }}>
            <div style={s.rowTitle}>{t.subject}</div>
            <div style={s.rowSub}>{t.category.replace(/_/g, ' ')} · {new Date(t.createdAt).toLocaleString()}</div>
            <div style={s.description}>{t.description}</div>
          </div>
          {user.role === 'PLATFORM_OWNER' ? (
            <select style={s.miniInput} value={t.status} onChange={(e) => changeStatus(t.id, e.target.value)}>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN PROGRESS</option>
              <option value="WAITING_ON_CUSTOMER">WAITING ON CUSTOMER</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="CLOSED">CLOSED</option>
            </select>
          ) : (
            <div style={s.badge}>{t.status.replace(/_/g, ' ')}</div>
          )}
        </div>
      ))}
      {tickets.length === 0 && <div style={s.empty}>No support tickets.</div>}
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8, gap: 12 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  description: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 6 },
  badge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap' },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
