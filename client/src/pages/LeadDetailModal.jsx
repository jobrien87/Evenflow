import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Modal, Badge, Button, Icon, LeadTypeIcon, StatTile } from '../ui';
import { PRODUCTS, PRODUCT_META } from '../lib/productMeta';

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
      <span style={s.infoIconWrap}><Icon name={icon} size={13} /></span>
      <span style={s.infoLabel}>{label}</span>
      <span style={s.infoValue}>{children}</span>
    </div>
  );
}

function fmt(dt) {
  return dt ? new Date(dt).toLocaleString() : '';
}

function money(cents) {
  return cents != null ? `$${(cents / 100).toFixed(2)}` : null;
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
      <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={800}>
        <div style={s.loading}>Loading…</div>
      </Modal>
    );
  }

  if (error || !lead) {
    return (
      <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={800}>
        <div style={s.error}>{error || 'Lead not found.'}</div>
      </Modal>
    );
  }

  const c = lead.customer;
  const vehicle = [lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(' ');
  const home = [lead.ownRent, lead.homeAge && `${lead.homeAge} yrs old`, lead.sqFootage && `${lead.sqFootage} sq ft`].filter(Boolean).join(' · ');
  const carrier = [lead.currentInsurance, lead.currentPremium && `$${lead.currentPremium}/mo`, lead.yearsWithCarrier].filter(Boolean).join(' · ');
  const custCarrier = lead.customFields?.currentCarrier;

  const productQuotes = lead.productQuotes || [];
  const soldCount = productQuotes.filter((q) => q.status === 'SOLD').length;

  return (
    <Modal onClose={onClose} title="LEAD PROFILE" maxWidth={800}>
      <div style={s.header}>
        <div style={s.headerAvatar}>
          <LeadTypeIcon type={lead.leadType} size={22} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={s.name}>{c ? `${c.firstName} ${c.lastName}` : 'Lead'}</div>
          <div style={s.meta}>
            {lead.vendor?.name ? `${lead.vendor.name} · ` : ''}
            {lead.source} · Received {fmt(lead.receivedAt)}
            {lead.assignedTo && ` · Assigned to ${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`}
            {` · ${lead.attemptCount || 0} attempt${lead.attemptCount === 1 ? '' : 's'}`}
          </div>
        </div>
        <div style={s.headerBadges}>
          {lead.product && <Badge tone="neutral">{lead.product}</Badge>}
          <Badge tone={soldCount > 0 ? 'accent' : 'neutral'}>{soldCount}/{PRODUCTS.length} SOLD</Badge>
          <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge>
        </div>
      </div>

      <Section title="PRODUCTS" icon="tag">
        <ProductsBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title="CONTACT & INTAKE INFO" icon="support">
        <div style={s.infoGrid}>
          <InfoRow icon="phone" label="Phone">{c?.phone}</InfoRow>
          <InfoRow icon="mail" label="Email">{c?.email}</InfoRow>
          <InfoRow icon="home" label="Address">{[lead.address || c?.address, lead.city || c?.city, lead.state || c?.state, lead.zip || c?.zip].filter(Boolean).join(', ')}</InfoRow>
          <InfoRow icon="clock" label="DOB">{lead.dob ? new Date(lead.dob).toLocaleDateString() : null}</InfoRow>
          <InfoRow icon="car" label="Vehicle">{vehicle}</InfoRow>
          <InfoRow icon="home" label="Home">{home}</InfoRow>
          <InfoRow icon="briefcase" label="Current carrier">{carrier || custCarrier}</InfoRow>
          <InfoRow icon="clock" label="Callback">{lead.callbackTime}</InfoRow>
          <InfoRow icon="support" label="Additional drivers">{lead.additionalDrivers}</InfoRow>
          <InfoRow icon="flame" label="Violations/Claims">{[lead.autoClaims, lead.violations, lead.homeClaims].filter(Boolean).join(' · ')}</InfoRow>
        </div>
        {lead.tmNotes && (
          <div style={s.notesBox}><strong>Submission notes:</strong> {lead.tmNotes}</div>
        )}
      </Section>

      <Section title="QUICK ACTIONS" icon="sparkle">
        <QuickActionsBlock lead={lead} user={user} onDone={refresh} />
      </Section>

      <Section title="DISPOSITION" icon="flag">
        <DispositionBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`FOLLOW-UP / APPOINTMENTS (${lead.tasks?.length || 0})`} icon="checklist">
        <TasksBlock lead={lead} user={user} onDone={refresh} />
      </Section>

      <Section title={`ACTIVITY LOG (${lead.activities?.length || 0})`} icon="phone">
        <ActivityBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`NOTES (${lead.notes?.length || 0})`} icon="pencil">
        <NotesBlock lead={lead} onDone={refresh} />
      </Section>

      <Section title={`HISTORY (${lead.events?.length || 0})`} icon="clock">
        <HistoryBlock lead={lead} />
      </Section>
    </Modal>
  );
}

const PRODUCT_STATUS_OPTIONS = [
  { value: null, label: 'Not Quoted' },
  { value: 'QUOTED', label: 'Quoted' },
  { value: 'SOLD', label: 'Sold' },
];

// One row per product, always editable — no click-to-reveal. Every row
// shows a 3-way status toggle plus its own premium field, so setting "what
// was quoted at what premium" or "what sold at what premium" is never
// hidden behind an extra step. Local pending edits vs. the lead's real
// saved productQuotes row is what drives the SAVE button's dirty state.
function ProductRow({ leadId, product, quote, onDone }) {
  const meta = PRODUCT_META[product];
  const savedStatus = quote?.status || null;
  const savedPremium = quote?.premiumCents != null ? (quote.premiumCents / 100).toFixed(2) : '';
  const [status, setStatus] = useState(savedStatus);
  const [premium, setPremium] = useState(savedPremium);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setStatus(savedStatus);
    setPremium(savedPremium);
  }, [savedStatus, savedPremium]);

  const dirty = status !== savedStatus || premium !== savedPremium;
  const tone = status === 'SOLD' ? 'accent' : status === 'QUOTED' ? 'warning' : 'neutral';

  async function save() {
    setBusy(true);
    setErr('');
    try {
      if (status === null) {
        await api.deleteProductQuote(leadId, product);
      } else {
        const premiumCents = premium ? Math.round(parseFloat(premium) * 100) : undefined;
        await api.logProductQuote(leadId, { product, status, premiumCents });
      }
      await onDone();
    } catch (e) {
      setErr(e.data?.message || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.productRow(tone)}>
      <div style={s.productRowIcon(tone)}><Icon name={meta.icon} size={17} /></div>
      <div style={s.productRowLabel}>{meta.label}</div>
      <div style={s.segmented}>
        {PRODUCT_STATUS_OPTIONS.map((opt) => {
          const active = status === opt.value;
          const disabled = opt.value === null && savedStatus === 'SOLD';
          return (
            <button
              key={opt.label}
              type="button"
              disabled={disabled}
              style={s.segmentButton(active, opt.value, disabled)}
              onClick={() => setStatus(opt.value)}
              title={disabled ? 'A sold product can’t be reverted to Not Quoted here.' : undefined}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div style={s.premiumWrap(status === null)}>
        <span style={s.premiumDollar}>$</span>
        <input
          style={s.premiumInput}
          placeholder="0.00"
          disabled={status === null}
          value={premium}
          onChange={(e) => setPremium(e.target.value)}
        />
        <span style={s.premiumSuffix}>/mo</span>
      </div>
      <Button variant={dirty ? 'primary' : 'secondary'} size="sm" disabled={!dirty || busy} onClick={save} style={s.productSaveButton}>
        {busy ? '…' : 'SAVE'}
      </Button>
      {err && <div style={s.formError}>{err}</div>}
    </div>
  );
}

// Per-product quote/sale tracker — independent of the lead's overall
// pipeline status. Setting a product's state (Not quoted / Quoted / Sold)
// and its real premium is what lets the app tell what still needs
// cross-selling: any product with no row here at all.
function ProductsBlock({ lead, onDone }) {
  const quotesByProduct = Object.fromEntries((lead.productQuotes || []).map((q) => [q.product, q]));
  const soldRows = (lead.productQuotes || []).filter((q) => q.status === 'SOLD');
  const quotedRows = (lead.productQuotes || []).filter((q) => q.status === 'QUOTED');
  const totalSoldCents = soldRows.reduce((sum, q) => sum + (q.premiumCents || 0), 0);
  const totalQuotedCents = quotedRows.reduce((sum, q) => sum + (q.premiumCents || 0), 0);
  const untouched = PRODUCTS.filter((p) => !quotesByProduct[p]);

  return (
    <div>
      <div style={s.statRow}>
        <StatTile label="SOLD PREMIUM / MO" value={money(totalSoldCents) || '$0.00'} />
        <StatTile label="OPEN QUOTE POTENTIAL / MO" value={money(totalQuotedCents) || '$0.00'} />
        <StatTile label="PRODUCTS SOLD" value={`${soldRows.length}/${PRODUCTS.length}`} />
      </div>
      <div style={s.productList}>
        {PRODUCTS.map((p) => (
          <ProductRow key={p} leadId={lead.id} product={p} quote={quotesByProduct[p]} onDone={onDone} />
        ))}
      </div>
      <div style={s.productsSummary}>
        {untouched.length > 0 ? (
          <span style={s.crossSellHint}>Needs cross-sell: {untouched.map((p) => PRODUCT_META[p].label).join(', ')}</span>
        ) : (
          <span style={s.crossSellHintDone}>Every product has been quoted or sold.</span>
        )}
      </div>
    </div>
  );
}

// Every claim/assign/disposition already writes a real LeadEvent — this
// just surfaces that existing audit trail, so anyone opening the lead can
// see everything that's happened without having to ask around.
function describeEvent(e) {
  const note = e.metadata?.note;
  const product = e.metadata?.product && (PRODUCT_META[e.metadata.product]?.label || e.metadata.product);
  const premium = money(e.metadata?.premiumCents);
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
    case 'lead.product_quoted':
      return `${product} marked as quoted${premium ? ` (${premium}/mo)` : ''}`;
    case 'lead.product_sold':
      return `${product} marked as sold${premium ? ` (${premium}/mo)` : ''}`;
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

function Section({ title, icon, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>
        {icon && <Icon name={icon} size={13} style={{ marginRight: 6, color: 'var(--accent)' }} />}
        <span style={s.sectionTitleText}>{title}</span>
      </div>
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
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await api.dispositionLead(lead.id, { status, note: note || undefined });
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
      <input style={{ ...s.input, flex: 1 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
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
  header: {
    display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 'var(--space-4)',
    paddingBottom: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)',
  },
  headerAvatar: {
    width: 44, height: 44, borderRadius: 'var(--radius-md)', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', color: 'var(--accent)',
    boxShadow: 'var(--shadow-glow-accent)',
  },
  name: { fontWeight: 700, fontSize: 19, color: 'var(--text-primary)' },
  meta: { color: 'var(--text-muted)', fontSize: 12, marginTop: 4 },
  headerBadges: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 },
  section: {
    marginBottom: 'var(--space-4)', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)',
    borderLeft: '3px solid rgba(198, 255, 46, 0.35)',
    borderRadius: 'var(--radius-md)', padding: 'var(--space-4)',
  },
  sectionTitle: {
    display: 'flex', alignItems: 'center', fontSize: 11,
    letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, textTransform: 'uppercase',
  },
  sectionTitleText: {
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  infoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  infoRow: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: 'var(--text-secondary)' },
  infoIconWrap: { display: 'inline-flex', color: 'var(--text-muted)', width: 16 },
  infoLabel: { color: 'var(--text-muted)', minWidth: 110 },
  infoValue: { color: 'var(--text-primary)' },
  notesBox: { marginTop: 10, padding: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' },
  quickActionsRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  quickActionsStatus: { color: 'var(--accent)', fontSize: 11, marginTop: 8 },
  formRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 },
  select: { padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  input: { padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, minWidth: 140 },
  miniInput: { padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, width: 110 },
  formError: { color: 'var(--danger)', fontSize: 11, width: '100%' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  listRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 6, fontSize: 12 },
  listMain: { flex: 1, color: 'var(--text-primary)' },
  listMeta: { color: 'var(--text-muted)', fontSize: 11 },
  noteRow: { padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  noteContent: { color: 'var(--text-primary)', fontSize: 12, marginTop: 4 },
  statRow: {
    display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, paddingBottom: 14,
    borderBottom: '1px solid var(--border-hairline)',
  },
  productList: { display: 'flex', flexDirection: 'column', gap: 8 },
  productRow: (tone) => ({
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px',
    borderRadius: 'var(--radius-sm)', position: 'relative',
    border: `1px solid ${tone === 'accent' ? 'var(--border-accent)' : tone === 'warning' ? 'rgba(255, 184, 77, 0.4)' : 'var(--border-hairline)'}`,
    background: tone === 'accent' ? 'var(--accent-gradient-soft)' : tone === 'warning' ? 'var(--warning-soft)' : 'var(--bg-elevated)',
    boxShadow: tone === 'accent' ? 'var(--shadow-glow-accent)' : 'none',
    transition: `box-shadow var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)`,
  }),
  productRowIcon: (tone) => ({
    width: 30, height: 30, borderRadius: 'var(--radius-sm)', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tone === 'accent' ? 'var(--accent)' : tone === 'warning' ? 'var(--warning)' : 'var(--text-muted)',
    background: 'var(--bg-sunken)',
  }),
  productRowLabel: { width: 90, flexShrink: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
  segmented: {
    display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0,
  },
  segmentButton: (active, value, disabled) => {
    const activeBg = value === 'SOLD' ? 'var(--accent-gradient)' : value === 'QUOTED' ? 'var(--warning)' : 'var(--bg-elevated)';
    const activeColor = value === 'SOLD' ? 'var(--accent-on)' : value === 'QUOTED' ? '#241a00' : 'var(--text-primary)';
    return {
      padding: '6px 10px', fontSize: 11, fontWeight: 700, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
      background: active ? activeBg : 'transparent',
      color: active ? activeColor : 'var(--text-muted)',
      opacity: disabled ? 0.4 : 1,
      borderRight: '1px solid var(--border-strong)',
    };
  },
  premiumWrap: (disabled) => ({
    display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-strong)', background: 'var(--bg-sunken)', opacity: disabled ? 0.4 : 1,
  }),
  premiumDollar: { color: 'var(--text-muted)', fontSize: 12 },
  premiumInput: {
    width: 72, padding: '7px 2px', background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700,
  },
  premiumSuffix: { color: 'var(--text-muted)', fontSize: 11 },
  productSaveButton: { flexShrink: 0, marginLeft: 'auto' },
  productsSummary: { marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12 },
  crossSellHint: { color: 'var(--warning)' },
  crossSellHintDone: { color: 'var(--accent)' },
};
