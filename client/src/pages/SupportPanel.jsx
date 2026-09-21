import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, SectionHeader, EmptyState } from '../ui';

const CATEGORIES = ['general', 'billing', 'technical', 'transfer_issue', 'vendor_issue', 'other'];

function statusTone(status) {
  if (status === 'OPEN') return 'warning';
  if (status === 'RESOLVED' || status === 'CLOSED') return 'accent';
  return 'neutral';
}

export default function SupportPanel() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'general', subject: '', description: '' });
  const [status, setStatus] = useState('');
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
  }, []);

  // Destination side of notification deep-linking.
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || tickets.length === 0) return;
    if (!tickets.some((t) => t.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`ticket-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, tickets]);

  async function load() {
    setLoadError('');
    try {
      const data = await api.supportTickets();
      setTickets(data.tickets);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load support tickets. Try refreshing.');
    } finally {
      setLoading(false);
    }
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

  if (loading) {
    return <div style={s.wrap}>Loading…</div>;
  }

  if (loadError) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>RETRY</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <SectionHeader
        right={<Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ NEW TICKET</Button>}
      >
        SUPPORT TICKETS ({tickets.length})
      </SectionHeader>

      {showForm && (
        <Card style={s.formCard}>
          <form onSubmit={submit} style={s.form}>
            <select style={s.input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
            <input style={s.input} placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
            <textarea style={{ ...s.input, minHeight: 70 }} placeholder="Describe the issue" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
            <Button variant="primary" type="submit">Submit Ticket</Button>
          </form>
        </Card>
      )}
      {status && <div style={s.status}>{status}</div>}

      {tickets.length === 0 ? (
        <EmptyState title="No support tickets" description="Tickets you or your team submit will show up here." />
      ) : (
        tickets.map((t) => (
          <Card key={t.id} id={`ticket-${t.id}`} style={t.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row} className="ui-row-stack">
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
              <Badge tone={statusTone(t.status)}>{t.status.replace(/_/g, ' ')}</Badge>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)' },
  formCard: { marginBottom: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  status: { color: 'var(--accent)', marginBottom: 12, fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 12 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  description: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 6 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
};
