import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Modal, Badge, Button } from '../ui';

const LEAD_STATUSES = [
  'NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT', 'QUOTE_STARTED',
  'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP', 'SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT',
  'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED',
];

const TASK_TYPES = ['FOLLOW_UP', 'CALLBACK', 'APPOINTMENT'];
const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'TEXT'];

function statusTone(status) {
  if (['SOLD', 'QUOTED_HOT'].includes(status)) return 'accent';
  if (['LOST', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

function InfoRow({ icon, label, children }) {
  if (!children) return null;
  return (
    <div style={s.infoRow}>
      <span style={s.infoIcon}>{icon}</span>
      <span style={s.infoLabel}>{label}</span>
      <span style={s.infoValue}>{children}</span>
    </div>
  );
}

function fmt(dt) {
  return dt ? new Date(dt).toLocaleString() : '';
}

export default function LeadDetailModal({ leadId, onClose, onChanged }) {
  const { user } = useAuth();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [leadId]);

  async function load() {
    setError('');
    try {
      const data = await api.leadDetail(leadId);
      setLead(data.lead);
    } catch (err) {
      setError(err.data?.message || 'Could not load this lead.');
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await load();
    onChanged?.();
  }

  if (loading) {
    return (
      <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={760}>
        <div style={s.loading}>Loading…</div>
      </Modal>
    );
  }

  if (error || !lead) {
    return (
      <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={760}>
        <div style={s.error}>{error || 'Lead not found.'}</div>
      </Modal>
    );
  }

  const c = lead.customer;
  const vehicle = [lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(' ');
  const home = [lead.ownRent, lead.homeAge && `${lead.homeAge} yrs old`, lead.sqFootage && `${lead.sqFootage} sq ft`].filter(Boolean).join(' · ');
  const carrier = [lead.currentInsurance, lead.currentPremium && `$${lead.currentPremium}/mo`, lead.yearsWithCarrier].filter(Boolean).join(' · ');
  const custCarrier = lead.customFields?.currentCarrier;

  return (
    <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={760}>
      <div style={s.header}>
        <div>
          <div style={s.name}>{c ? `${c.firstName} ${c.lastName}` : 'Lead'}</div>
          <div style={s.meta}>
            {lead.vendor?.name ? `${lead.vendor.name} · ` : ''}
            {lead.source} · Received {fmt(lead.receivedAt)}
            {lead.assignedTo && ` · Assigned to ${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`}
            {` · ${lead.attemptCount || 0} attempt${lead.attemptCount === 1 ? '' : 's'}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {lead.product && <Badge tone="neutral">{lead.product}</Badge>}
          <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge>
        </div>
      </div>

      <Section title="CONTACT & INTAKE INFO">
        <div style={s.infoGrid}>
          <InfoRow icon="📞" label="Phone">{c?.phone}</InfoRow>
          <InfoRow icon="✉️" label="Email">{c?.email}</InfoRow>
          <InfoRow icon="🏠" label="Address">{[lead.address || c?.address, lead.city || c?.city, lead.state || c?.state, lead.zip || c?.zip].filter(Boolean).join(', ')}</InfoRow>
          <InfoRow icon="🎂" label="DOB">{lead.dob ? new Date(lead.dob).toLocaleDateString() : null}</InfoRow>
          <InfoRow icon="🚗" label="Vehicle">{vehicle}</InfoRow>
          <InfoRow icon="🏘️" label="Home">{home}</InfoRow>
          <InfoRow icon="🏢" label="Current carrier">{carrier || custCarrier}</InfoRow>
          <InfoRow icon="📅" label="Callback">{lead.callbackTime}</InfoRow>
          <InfoRow icon="👤" label="Additional drivers">{lead.additionalDrivers}</InfoRow>
          <InfoRow icon="⚠️" label="Violations/Claims">{[lead.autoClaims, lead.violations, lead.homeClaims].filter(Boolean).join(' · ')}</InfoRow>
        </div>
        {lead.tmNotes && (
          <div style={s.notesBox}><strong>Submission notes:</strong> {lead.tmNotes}</div>
        )}
      </Section>

      <Section title="QUICK ACTIONS">
        <QuickActionsBlock lead={lead} user={user} onDone={refresh} />
      </Section>

      <Section title="DISPOSITION">
        <DispositionBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`FOLLOW-UP / APPOINTMENTS (${lead.tasks?.length || 0})`}>
        <TasksBlock lead={lead} user={user} onDone={refresh} />
      </Section>

      <Section title={`ACTIVITY LOG (${lead.activities?.length || 0})`}>
        <ActivityBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`NOTES (${lead.notes?.length || 0})`}>
        <NotesBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`HISTORY (${lead.events?.length || 0})`}>
        <HistoryBlock lead={lead} />
      </Section>
    </Modal>
  );
}

// Every claim/assign/disposition already writes a real LeadEvent — this
// just surfaces that existing audit trail, so anyone opening the lead can
// see everything that's happened without having to ask around.
function describeEvent(e) {
  const note = e.metadata?.note;
  switch (e.type) {
    case 'lead.created':
      return 'Lead created';
    case 'lead.created.possible_duplicate':
      return 'Lead created (flagged as a possible duplicate)';
    case 'lead.assigned':
      return 'Assigned to a producer';
    case 'lead.new':
      return 'New lead received';
    case 'lead.claimed':
      return 'Claimed from the Moshpit';
    case 'lead.disposition':
      return `Disposition: ${e.fromStatus?.replace(/_/g, ' ') || '—'} → ${e.toStatus?.replace(/_/g, ' ') || '—'}${note ? ` — "${note}"` : ''}`;
    default:
      return e.type.replace(/_/g, ' ');
  }
}

function HistoryBlock({ lead }) {
  const events = lead.events || [];
  if (events.length === 0) return <div style={s.empty}>No history yet.</div>;
  return (
    <div style={s.list}>
      {events.map((e) => (
        <div key={e.id} style={s.listRow}>
          <span style={s.listMain}>{describeEvent(e)}</span>
          <span style={s.listMeta}>{fmt(e.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

// One-click versions of the same real actions ActivityBlock/NotesBlock
// support with a fuller form below — reuses the exact same
// api.logLeadActivity/api.createLeadNote calls, just a faster entry point
// for the common case (matches the old system's "Quick Actions" panel).
function QuickActionsBlock({ lead, user, onDone }) {
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');

  async function quickLog(type, label) {
    setBusy(type);
    setStatus('');
    try {
      await api.logLeadActivity(lead.id, { type, direction: 'OUTBOUND' });
      setStatus(`${label} logged.`);
      await onDone();
    } catch (e) {
      setStatus(e.data?.message || `Failed to log ${label.toLowerCase()}.`);
    } finally {
      setBusy(null);
    }
  }

  async function markSent() {
    setBusy('SENT');
    setStatus('');
    try {
      await api.logLeadActivity(lead.id, { type: 'EMAIL', direction: 'OUTBOUND', outcome: 'Quote sent' });
      setStatus('Marked as sent.');
      await onDone();
    } catch (e) {
      setStatus(e.data?.message || 'Failed to mark as sent.');
    } finally {
      setBusy(null);
    }
  }

  async function copyIntro() {
    const c = lead.customer;
    const firstName = c?.firstName || 'there';
    const line = `Hi ${firstName}, this is ${user?.firstName || ''} — following up on your${lead.product ? ` ${lead.product}` : ''} quote request. Do you have a couple minutes to go over some options?`;
    try {
      await navigator.clipboard.writeText(line);
      setStatus('Intro text copied to clipboard.');
    } catch {
      setStatus('Could not copy — clipboard access is blocked.');
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setBusy('NOTE');
    setStatus('');
    try {
      await api.createLeadNote(lead.id, noteText.trim());
      setNoteText('');
      setNoteOpen(false);
      setStatus('Note added.');
      await onDone();
    } catch (e) {
      setStatus(e.data?.message || 'Failed to add note.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={s.quickActionsRow}>
        <Button variant="secondary" size="sm" disabled={busy === 'CALL'} onClick={() => quickLog('CALL', 'Call')}>LOG CALL</Button>
        <Button variant="secondary" size="sm" onClick={copyIntro}>COPY INTRO TEXT</Button>
        <Button variant="secondary" size="sm" disabled={busy === 'SENT'} onClick={markSent}>MARK AS SENT</Button>
        <Button variant="secondary" size="sm" disabled={busy === 'TEXT'} onClick={() => quickLog('TEXT', 'Text')}>LOG TEXT</Button>
        <Button variant="secondary" size="sm" disabled={busy === 'EMAIL'} onClick={() => quickLog('EMAIL', 'Email')}>LOG EMAIL</Button>
        <Button variant="secondary" size="sm" onClick={() => setNoteOpen((v) => !v)}>ADD NOTE</Button>
      </div>
      {noteOpen && (
        <div style={s.formRow}>
          <input style={{ ...s.input, flex: 1 }} placeholder="Quick note…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          <Button variant="primary" size="sm" disabled={busy === 'NOTE' || !noteText.trim()} onClick={addNote}>SAVE</Button>
        </div>
      )}
      {status && <div style={s.quickActionsStatus}>{status}</div>}
    </div>
  );
}

function DispositionBlock({ lead, onDone }) {
  const [status, setStatus] = useState(lead.status);
  const [premium, setPremium] = useState('');
  const [saleProduct, setSaleProduct] = useState(lead.product || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await api.dispositionLead(lead.id, {
        status,
        note: note || undefined,
        saleProduct: status === 'SOLD' ? saleProduct : undefined,
        salePremiumCents: status === 'SOLD' && premium ? Math.round(parseFloat(premium) * 100) : undefined,
      });
      setNote('');
      await onDone();
    } catch (e) {
      setErr(e.data?.message || 'Failed to update disposition.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.formRow}>
      <select style={s.select} value={status} onChange={(e) => setStatus(e.target.value)}>
        {LEAD_STATUSES.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
      </select>
      {status === 'SOLD' && (
        <>
          <input style={s.input} placeholder="Product" value={saleProduct} onChange={(e) => setSaleProduct(e.target.value)} />
          <input style={s.miniInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
        </>
      )}
      <input style={s.input} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button variant="primary" size="sm" disabled={busy || (status === lead.status && !note)} onClick={submit}>SAVE</Button>
      {err && <div style={s.formError}>{err}</div>}
    </div>
  );
}

function TasksBlock({ lead, user, onDone }) {
  const [type, setType] = useState('FOLLOW_UP');
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.createTask({
        leadId: lead.id,
        type,
        title: title.trim(),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        assignedToId: user?.id,
      });
      setTitle('');
      setDueAt('');
      await onDone();
    } catch (e) {
      setErr(e.data?.message || 'Failed to create follow-up.');
    } finally {
      setBusy(false);
    }
  }

  async function complete(taskId) {
    await api.completeTask(taskId, { status: 'COMPLETED' });
    await onDone();
  }

  return (
    <div>
      <div style={s.formRow}>
        <select style={s.select} value={type} onChange={(e) => setType(e.target.value)}>
          {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <input style={s.input} placeholder="What needs to happen" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input style={s.miniInput} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={busy || !title.trim()} onClick={create}>ADD</Button>
      </div>
      {err && <div style={s.formError}>{err}</div>}

      {(lead.tasks || []).length === 0 ? (
        <div style={s.empty}>No follow-ups scheduled.</div>
      ) : (
        <div style={s.list}>
          {lead.tasks.map((t) => (
            <div key={t.id} style={s.listRow}>
              <Badge tone={t.status === 'COMPLETED' ? 'accent' : t.status === 'CANCELLED' ? 'danger' : 'neutral'}>{t.status}</Badge>
              <span style={s.listMain}>{t.title}</span>
              <span style={s.listMeta}>{t.type.replace(/_/g, ' ')}{t.dueAt ? ` · due ${fmt(t.dueAt)}` : ''}</span>
              {t.status === 'OPEN' && <Button variant="ghost" size="sm" onClick={() => complete(t.id)}>MARK DONE</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityBlock({ lead, onDone }) {
  const [type, setType] = useState('CALL');
  const [direction, setDirection] = useState('OUTBOUND');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function log() {
    setBusy(true);
    setErr('');
    try {
      await api.logLeadActivity(lead.id, { type, direction, outcome: outcome || undefined });
      setOutcome('');
      await onDone();
    } catch (e) {
      setErr(e.data?.message || 'Failed to log activity.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={s.formRow}>
        <select style={s.select} value={type} onChange={(e) => setType(e.target.value)}>
          {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={s.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="OUTBOUND">Outbound</option>
          <option value="INBOUND">Inbound</option>
        </select>
        <input style={s.input} placeholder="Outcome (optional — e.g. 'no answer', 'left voicemail')" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={busy} onClick={log}>LOG</Button>
      </div>
      {err && <div style={s.formError}>{err}</div>}

      {(lead.activities || []).length === 0 ? (
        <div style={s.empty}>No calls, emails, or texts logged yet.</div>
      ) : (
        <div style={s.list}>
          {lead.activities.map((a) => (
            <div key={a.id} style={s.listRow}>
              <Badge tone="neutral">{a.type}</Badge>
              <span style={s.listMain}>{a.outcome || `${a.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} ${a.type.toLowerCase()}`}</span>
              <span style={s.listMeta}>{a.createdBy?.firstName} {a.createdBy?.lastName} · {fmt(a.occurredAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotesBlock({ lead, onDone }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function add() {
    if (!content.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.createLeadNote(lead.id, content.trim());
      setContent('');
      await onDone();
    } catch (e) {
      setErr(e.data?.message || 'Failed to add note.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={s.formRow}>
        <input style={{ ...s.input, flex: 1 }} placeholder="Add a note…" value={content} onChange={(e) => setContent(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={busy || !content.trim()} onClick={add}>ADD NOTE</Button>
      </div>
      {err && <div style={s.formError}>{err}</div>}

      {(lead.notes || []).length === 0 ? (
        <div style={s.empty}>No notes yet.</div>
      ) : (
        <div style={s.list}>
          {lead.notes.map((n) => (
            <div key={n.id} style={s.noteRow}>
              <div style={s.listMeta}>{n.author?.firstName} {n.author?.lastName} · {fmt(n.createdAt)}</div>
              <div style={s.noteContent}>{n.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  loading: { color: 'var(--text-secondary)', padding: 20, textAlign: 'center' },
  error: { color: 'var(--danger)', padding: 20, textAlign: 'center' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 'var(--space-4)', paddingBottom: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' },
  name: { fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' },
  meta: { color: 'var(--text-muted)', fontSize: 12, marginTop: 4 },
  section: { marginBottom: 'var(--space-5)' },
  sectionTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 },
  infoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  infoRow: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: 'var(--text-secondary)' },
  infoIcon: { fontSize: 12, width: 16 },
  infoLabel: { color: 'var(--text-muted)', minWidth: 110 },
  infoValue: { color: 'var(--text-primary)' },
  notesBox: { marginTop: 10, padding: 10, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' },
  quickActionsRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  quickActionsStatus: { color: 'var(--accent)', fontSize: 11, marginTop: 8 },
  formRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 },
  select: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  input: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, minWidth: 140 },
  miniInput: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, width: 110 },
  formError: { color: 'var(--danger)', fontSize: 11, width: '100%' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  listRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, fontSize: 12 },
  listMain: { flex: 1, color: 'var(--text-primary)' },
  listMeta: { color: 'var(--text-muted)', fontSize: 11 },
  noteRow: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  noteContent: { color: 'var(--text-primary)', fontSize: 12, marginTop: 4 },
};
