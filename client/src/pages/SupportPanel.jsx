import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, StatTile, BarRow, SectionHeader, EmptyState, MicButton } from '../ui';

const CATEGORIES = ['general', 'billing', 'technical', 'transfer_issue', 'vendor_issue', 'other'];
const STATUS_ORDER = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'];

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

  const total = tickets.length;
  const open = tickets.filter((t) => t.status === 'OPEN').length;
  const inProgress = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const closedOut = tickets.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED').length;
  const closeRate = total > 0 ? Math.round((closedOut / total) * 100) : 0;
  const statusCounts = STATUS_ORDER.map((st) => ({
    status: st,
    count: tickets.filter((t) => t.status === st).length,
  })).filter((row) => row.count > 0);

  return (
    <div style={s.wrap}>
      <SectionHeader
        right={<Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ NEW TICKET</Button>}
      >
        SUPPORT TICKETS ({tickets.length})
      </SectionHeader>

      <div style={s.statsRow}>
        <StatTile label="Total Tickets" value={total} />
        <StatTile label="Open" value={open} sub={open > 0 ? 'needs eyes' : 'inbox zero'} />
        <StatTile label="In Progress" value={inProgress} />
        <StatTile label="Closed Out" value={closedOut} sub={`${closeRate}% close rate`} />
      </div>

      {total > 0 && (
        <Card style={s.breakdownCard}>
          <div style={s.breakdownTitle}>BY STATUS</div>
          {statusCounts.map((row) => (
            <BarRow
              key={row.status}
              label={row.status.replace(/_/g, ' ')}
              value={row.count}
              max={total}
              valueLabel={row.count}
            />
          ))}
        </Card>
      )}

      {showForm && (
        <Card style={s.formCard}>
          <form onSubmit={submit} style={s.form}>
            <select style={s.input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
            <input style={s.input} placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
            <div style={{ position: 'relative' }}>
              <textarea style={{ ...s.input, minHeight: 70, width: '100%' }} placeholder="Describe the issue" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
              <MicButton
                style={{ position: 'absolute', bottom: 8, right: 8 }}
                onTranscript={(text) => setForm((f) => ({ ...f, description: f.description ? `${f.description} ${text}` : text }))}
              />
            </div>
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
  statsRow: { display: 'flex', gap: 32, marginBottom: 20, flexWrap: 'wrap' },
  breakdownCard: { marginBottom: 16 },
  breakdownTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 },
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
