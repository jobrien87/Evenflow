import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, StatTile, Icon, MicButton } from '../ui';

const CATEGORIES = [
  { value: 'technical_issue', label: 'Technical issue' },
  { value: 'lead_data_or_routing', label: 'Lead data or routing' },
  { value: 'billing_or_subscription', label: 'Billing or subscription' },
  { value: 'account_access', label: 'Account access' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'other_support', label: 'Other support' },
];
const URGENCIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];
const ROLE_ACCESS_LABEL = {
  AGENCY_OWNER: 'Agency Owner Access',
  AGENCY_MANAGER: 'Agency Manager Access',
  PRODUCER: 'Producer Access',
  TELEMARKETER: 'Telemarketer Access',
  PLATFORM_OWNER: 'Platform Owner Access',
};

function statusTone(status) {
  if (status === 'OPEN') return 'warning';
  if (status === 'RESOLVED' || status === 'CLOSED') return 'accent';
  return 'neutral';
}

function urgencyTone(urgency) {
  if (urgency === 'urgent') return 'danger';
  if (urgency === 'high') return 'warning';
  return 'neutral';
}

export default function SupportPanel() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ category: CATEGORIES[0].value, subject: '', description: '', urgency: 'normal' });
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
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
    setSubmitting(true);
    setStatus('Submitting…');
    try {
      await api.createSupportTicket({
        category: form.category,
        subject: form.subject,
        description: form.description,
        metadata: { urgency: form.urgency },
      });
      setStatus('Ticket submitted.');
      setForm({ category: CATEGORIES[0].value, subject: '', description: '', urgency: 'normal' });
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to create ticket.');
    } finally {
      setSubmitting(false);
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
  const isPlatformOwner = user.role === 'PLATFORM_OWNER';

  return (
    <div style={s.wrap}>
      <div style={isMobile ? s.heroStacked : s.hero}>
        <div style={{ flex: 1 }}>
          <div style={s.accessBadge}>
            <Icon name="ticket" size={12} />
            {(ROLE_ACCESS_LABEL[user.role] || 'Team Access').toUpperCase()}
          </div>
          <h1 style={s.title}>Backstage Pass</h1>
          <p style={s.subtitle}>
            {isPlatformOwner
              ? 'A private support workspace for the whole platform. Open a ticket for a technical issue, billing question, account need, or change request and track its status here.'
              : 'A private support workspace for your agency. Open a ticket for a technical issue, lead-data question, account need, or change request and track its status here.'}
          </p>
        </div>
        <StatTile label="Open Tickets" value={open} tone="lime" />
      </div>

      <div style={s.divider} />

      <div style={isMobile ? s.columnsStacked : s.columns}>
        <Card style={s.formCard}>
          <div style={s.formHeaderRow}>
            <div style={s.helpIconBox}><Icon name="help" size={18} /></div>
            <div>
              <div style={s.formTitle}>Open a support ticket</div>
              <div style={s.formSubtitle}>Include the lead name, page, or workflow step when relevant.</div>
            </div>
          </div>

          <form onSubmit={submit} style={s.form}>
            <div style={s.fieldLabel}>SUPPORT CATEGORY</div>
            <div style={s.categoryGrid}>
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c.value}
                  style={form.category === c.value ? { ...s.tile, ...s.tileSelected } : s.tile}
                  onClick={() => setForm({ ...form, category: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div style={s.fieldLabel}>SUBJECT</div>
            <input
              style={s.input}
              placeholder="Example: Meta leads are not assigning correctly"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              required
            />

            <div style={s.fieldLabel}>WHAT DO YOU NEED HELP WITH?</div>
            <div style={{ position: 'relative' }}>
              <textarea
                style={s.textarea}
                placeholder="What happened, when did it start, and what outcome do you need?"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                required
              />
              <MicButton
                style={{ position: 'absolute', bottom: 8, right: 8 }}
                onTranscript={(text) => setForm((f) => ({ ...f, description: f.description ? `${f.description} ${text}` : text }))}
              />
            </div>

            <div style={s.fieldLabel}>URGENCY</div>
            <div style={s.urgencyGrid}>
              {URGENCIES.map((u) => (
                <button
                  type="button"
                  key={u.value}
                  style={form.urgency === u.value ? { ...s.tile, ...s.tileSelected } : s.tile}
                  onClick={() => setForm({ ...form, urgency: u.value })}
                >
                  {u.label}
                </button>
              ))}
            </div>

            <Button variant="primary" type="submit" disabled={submitting} style={s.submitButton}>
              <Icon name="send" size={15} style={{ marginRight: 8 }} />
              {submitting ? 'Submitting…' : 'Submit to support'}
            </Button>
            {status && <div style={s.status}>{status}</div>}
          </form>
        </Card>

        <Card style={s.historyCard}>
          <div style={s.historyHeaderRow}>
            <div>
              <div style={s.formTitle}>Your support history</div>
              <div style={s.formSubtitle}>Updates and support responses appear on the ticket.</div>
            </div>
            <Badge tone="neutral">{total} total</Badge>
          </div>
          {total > 0 && (
            <div style={s.historySummary}>
              {open} open · {inProgress} in progress · {closedOut} closed
            </div>
          )}

          {tickets.length === 0 ? (
            <div style={s.emptyBox}>
              <Icon name="ticket" size={28} style={{ color: 'var(--text-muted)', marginBottom: 10 }} />
              <div style={s.emptyTitle}>No support tickets yet</div>
              <div style={s.emptyDescription}>Your submitted tickets will be tracked here.</div>
            </div>
          ) : (
            <div style={s.historyList}>
              {tickets.map((t) => (
                <div key={t.id} id={`ticket-${t.id}`} style={t.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row}>
                  <div style={{ flex: 1 }}>
                    <div style={s.rowTitle}>{t.subject}</div>
                    <div style={s.rowSub}>{t.category.replace(/_/g, ' ')} · {new Date(t.createdAt).toLocaleString()}</div>
                    <div style={s.description}>{t.description}</div>
                  </div>
                  <div style={s.rowBadges}>
                    {t.metadata?.urgency && <Badge tone={urgencyTone(t.metadata.urgency)}>{t.metadata.urgency.toUpperCase()}</Badge>}
                    {isPlatformOwner ? (
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
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  hero: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 'var(--space-5)' },
  heroStacked: { display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 'var(--space-5)' },
  accessBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, marginBottom: 12,
    background: 'var(--surface-tint-lime)', border: '1px solid var(--surface-tint-lime-border)',
    color: 'var(--accent)', fontSize: 10, fontWeight: 700, letterSpacing: 1,
  },
  title: { fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' },
  subtitle: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, maxWidth: 560, margin: 0 },
  divider: { borderTop: '1px solid var(--border-hairline)', marginBottom: 'var(--space-5)' },
  columns: { display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 24, alignItems: 'start' },
  columnsStacked: { display: 'flex', flexDirection: 'column', gap: 20 },
  formCard: {},
  historyCard: {},
  formHeaderRow: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 },
  helpIconBox: {
    width: 36, height: 36, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--surface-tint-lime)', border: '1px solid var(--surface-tint-lime-border)', color: 'var(--accent)',
  },
  formTitle: { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' },
  formSubtitle: { color: 'var(--text-muted)', fontSize: 12, marginTop: 3, lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginTop: 12, marginBottom: 6 },
  categoryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  urgencyGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 },
  tile: {
    padding: '10px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
    background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
  },
  tileSelected: {
    background: 'var(--surface-tint-lime)', border: '1px solid var(--accent)', color: 'var(--accent)',
  },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  textarea: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, minHeight: 80, width: '100%', resize: 'vertical' },
  submitButton: { marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' },
  status: { color: 'var(--accent)', marginTop: 10, fontSize: 12, textAlign: 'center' },
  historyHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 },
  historySummary: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 16 },
  emptyBox: {
    textAlign: 'center', padding: 'var(--space-8) var(--space-4)', borderRadius: 8, marginTop: 16,
    border: '1px dashed var(--border-strong)', background: 'var(--bg-sunken)',
  },
  emptyTitle: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, marginBottom: 4 },
  emptyDescription: { color: 'var(--text-muted)', fontSize: 12 },
  historyList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16 },
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)', borderRadius: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-hairline)' },
  rowBadges: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 },
  rowTitle: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  description: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 6 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
};
