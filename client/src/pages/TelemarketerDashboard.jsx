import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useIsMobile } from '../lib/useViewport';
import { Card, Badge, Button, SectionHeader, EmptyState, StatTile, BarRow, MicButton } from '../ui';
import ChatThread from './ChatThread';

const PRODUCTS = ['Auto', 'Home', 'Home and Auto Bundle', 'Life', 'Health'];

const EMPTY_FORM = {
  product: 'Auto',
  isLiveTransfer: false,
  firstName: '', lastName: '', phone: '', email: '',
  dob: '', address: '', city: '', state: '', zip: '',
  vehicleYear: '', vehicleMake: '', vehicleModel: '', additionalDrivers: '', autoClaims: '', violations: '',
  ownRent: '', homeAge: '', sqFootage: '', homeClaims: '',
  currentInsurance: '', currentPremium: '', yearsWithCarrier: '',
  callbackTime: '', tmNotes: '',
};

function statusTone(status) {
  if (status === 'SOLD') return 'accent';
  if (['LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'].includes(status)) return 'danger';
  if (status === 'NEW') return 'warning';
  return 'neutral';
}

export default function TelemarketerDashboard() {
  const isMobile = useIsMobile();
  const [assignments, setAssignments] = useState(null);
  const [assignmentsError, setAssignmentsError] = useState('');
  const [agencyId, setAgencyId] = useState('');
  const [submissions, setSubmissions] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadAssignments();
  }, []);

  useEffect(() => {
    loadSubmissions();
    const interval = setInterval(loadSubmissions, 8000);
    return () => clearInterval(interval);
  }, []);

  async function loadAssignments() {
    setAssignmentsError('');
    try {
      const data = await api.myAssignments();
      setAssignments(data.assignments);
      if (data.assignments.length === 1) setAgencyId(data.assignments[0].agency.id);
    } catch (err) {
      setAssignmentsError(err.data?.message || 'Could not load your assignments. Try refreshing.');
    }
  }

  async function loadSubmissions() {
    try {
      const data = await api.leads();
      setSubmissions(data.leads);
    } catch {
      // Polled every 8s — a transient failure here shouldn't blank out
      // an already-loaded submissions list; the next poll retries.
    }
  }

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!agencyId) return;
    setBusy(true);
    setResult(null);
    try {
      const payload = {
        ...form,
        agencyId,
        state: form.state.toUpperCase(),
        dob: form.dob ? new Date(form.dob).toISOString() : '',
      };
      const res = await api.createLead(payload);
      setResult({ success: true });
      setForm(EMPTY_FORM);
      await loadSubmissions();
      return res;
    } catch (err) {
      setResult({ error: err.data?.message || err.message });
    } finally {
      setBusy(false);
    }
  }

  // Computed client-side from the submissions array this page already
  // polls every 8s (api.leads()) — no extra fetch for a summary.
  const submissionStats = useMemo(() => {
    const total = submissions.length;
    const byStatus = new Map();
    for (const lead of submissions) {
      byStatus.set(lead.status, (byStatus.get(lead.status) || 0) + 1);
    }
    const sold = byStatus.get('SOLD') || 0;
    const closeRate = total > 0 ? Math.round((sold / total) * 100) : null;
    const breakdown = [...byStatus.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
    return { total, sold, closeRate, breakdown };
  }, [submissions]);

  if (assignments === null) {
    if (assignmentsError) {
      return (
        <div style={s.wrap}>
          <div style={s.loadErrorBox}>
            {assignmentsError}
            <Button variant="secondary" size="sm" onClick={loadAssignments}>RETRY</Button>
          </div>
        </div>
      );
    }
    return <div style={s.wrap}>Loading…</div>;
  }

  if (assignments.length === 0) {
    return (
      <div style={s.wrap}>
        <SectionHeader>YIELD TRANSFERS</SectionHeader>
        <div style={s.noAssignmentBanner}>
          No offices are assigned yet. Contact Yield Operations before submitting leads — a submission has nowhere to go without an assignment.
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <SectionHeader>YIELD TRANSFERS</SectionHeader>

      {assignments.length > 1 && (
        <div style={s.officesRow}>
          {assignments.map((a) => (
            <button
              key={a.id}
              type="button"
              style={s.officeChip(a.agency.id === agencyId)}
              onClick={() => setAgencyId(a.agency.id)}
            >
              {a.agency.name}
            </button>
          ))}
        </div>
      )}

      <div style={isMobile ? s.stacked : s.split}>
        <div style={s.formColumn}>
          <LeadForm form={form} setField={setField} onSubmit={submit} busy={busy} result={result} />
        </div>
        <div style={s.chatColumn}>
          {agencyId ? (
            <ChatThread entityType="AGENCY" entityId={agencyId} variant="inline" title="TEAM CHAT" />
          ) : (
            <Card style={s.chatPlaceholder}>Select an office above to see its team chat.</Card>
          )}
        </div>
      </div>

      <div style={s.section}>
        <h3 style={s.h3}>MY RECENT SUBMISSIONS</h3>
        {submissions.length === 0 ? (
          <EmptyState title="No submissions yet" description="Leads you submit will show up here — and so will the SOLD count, once you land one." />
        ) : (
          <>
            <div style={s.statsRow}>
              <StatTile label="Submitted" value={submissionStats.total} />
              <StatTile label="Sold" value={submissionStats.sold} sub={submissionStats.sold > 0 ? 'nice work' : undefined} />
              <StatTile label="Close Rate" value={submissionStats.closeRate === null ? '—' : `${submissionStats.closeRate}%`} />
            </div>
            <Card style={s.breakdownCard}>
              <div style={s.breakdownTitle}>BY STATUS</div>
              {submissionStats.breakdown.map((row) => (
                <BarRow
                  key={row.status}
                  label={row.status.replace(/_/g, ' ')}
                  value={row.count}
                  max={submissionStats.total}
                  valueLabel={row.count}
                />
              ))}
            </Card>
            {submissions.map((lead) => (
              <Card key={lead.id} style={s.row}>
                <div>
                  <div style={s.rowTitle}>
                    {lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'Lead'} · {lead.product || ''} · {lead.state || ''}
                  </div>
                  <div style={s.rowSub}>{new Date(lead.receivedAt).toLocaleString()}</div>
                </div>
                <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, ' ')}</Badge>
              </Card>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={s.fieldLabel}>
      {label}
      {children}
    </label>
  );
}

function LeadForm({ form, setField, onSubmit, busy, result }) {
  return (
    <Card style={s.formCard}>
      <form onSubmit={onSubmit} style={s.form}>
        <h4 style={s.formSectionTitle}>LEAD DESTINATION</h4>
        <div style={s.formGrid}>
          <Field label="Product">
            <select style={s.input} value={form.product} onChange={(e) => setField('product', e.target.value)}>
              {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
        </div>
        <label style={s.liveTransferRow}>
          <input
            type="checkbox"
            checked={form.isLiveTransfer}
            onChange={(e) => setField('isLiveTransfer', e.target.checked)}
          />
          This is a live transfer — the caller is on the line right now
        </label>

        <h4 style={s.formSectionTitle}>CONTACT INFO</h4>
        <div style={s.formGrid}>
          <Field label="First name"><input style={s.input} value={form.firstName} onChange={(e) => setField('firstName', e.target.value)} required /></Field>
          <Field label="Last name"><input style={s.input} value={form.lastName} onChange={(e) => setField('lastName', e.target.value)} required /></Field>
          <Field label="Phone"><input style={s.input} value={form.phone} onChange={(e) => setField('phone', e.target.value)} /></Field>
          <Field label="Email"><input style={s.input} type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} /></Field>
          <Field label="Date of birth"><input style={s.input} type="date" value={form.dob} onChange={(e) => setField('dob', e.target.value)} /></Field>
          <Field label="Address"><input style={s.input} value={form.address} onChange={(e) => setField('address', e.target.value)} /></Field>
          <Field label="City"><input style={s.input} value={form.city} onChange={(e) => setField('city', e.target.value)} /></Field>
          <Field label="State"><input style={s.input} maxLength={2} value={form.state} onChange={(e) => setField('state', e.target.value)} required /></Field>
          <Field label="ZIP"><input style={s.input} value={form.zip} onChange={(e) => setField('zip', e.target.value)} /></Field>
        </div>

        <h4 style={s.formSectionTitle}>VEHICLE INFO</h4>
        <div style={s.formGrid}>
          <Field label="Year"><input style={s.input} value={form.vehicleYear} onChange={(e) => setField('vehicleYear', e.target.value)} /></Field>
          <Field label="Make"><input style={s.input} value={form.vehicleMake} onChange={(e) => setField('vehicleMake', e.target.value)} /></Field>
          <Field label="Model"><input style={s.input} value={form.vehicleModel} onChange={(e) => setField('vehicleModel', e.target.value)} /></Field>
          <Field label="Additional drivers"><input style={s.input} value={form.additionalDrivers} onChange={(e) => setField('additionalDrivers', e.target.value)} /></Field>
          <Field label="Auto claims"><input style={s.input} value={form.autoClaims} onChange={(e) => setField('autoClaims', e.target.value)} /></Field>
          <Field label="Violations"><input style={s.input} value={form.violations} onChange={(e) => setField('violations', e.target.value)} /></Field>
        </div>

        <h4 style={s.formSectionTitle}>HOME INFO</h4>
        <div style={s.formGrid}>
          <Field label="Own / rent"><input style={s.input} value={form.ownRent} onChange={(e) => setField('ownRent', e.target.value)} /></Field>
          <Field label="Home age"><input style={s.input} value={form.homeAge} onChange={(e) => setField('homeAge', e.target.value)} /></Field>
          <Field label="Sq footage"><input style={s.input} value={form.sqFootage} onChange={(e) => setField('sqFootage', e.target.value)} /></Field>
          <Field label="Home claims"><input style={s.input} value={form.homeClaims} onChange={(e) => setField('homeClaims', e.target.value)} /></Field>
        </div>

        <h4 style={s.formSectionTitle}>CURRENT INSURANCE</h4>
        <div style={s.formGrid}>
          <Field label="Current carrier"><input style={s.input} value={form.currentInsurance} onChange={(e) => setField('currentInsurance', e.target.value)} /></Field>
          <Field label="Current premium"><input style={s.input} value={form.currentPremium} onChange={(e) => setField('currentPremium', e.target.value)} /></Field>
          <Field label="Years with carrier"><input style={s.input} value={form.yearsWithCarrier} onChange={(e) => setField('yearsWithCarrier', e.target.value)} /></Field>
        </div>

        <h4 style={s.formSectionTitle}>CALL NOTES</h4>
        <div style={s.formGrid}>
          <Field label="Callback time"><input style={s.input} value={form.callbackTime} onChange={(e) => setField('callbackTime', e.target.value)} /></Field>
        </div>
        <Field label="TM notes">
          <div style={{ position: 'relative' }}>
            <textarea style={{ ...s.input, minHeight: 70, width: '100%' }} value={form.tmNotes} onChange={(e) => setField('tmNotes', e.target.value)} />
            <MicButton
              style={{ position: 'absolute', bottom: 8, right: 8 }}
              onTranscript={(text) => setField('tmNotes', form.tmNotes ? `${form.tmNotes} ${text}` : text)}
            />
          </div>
        </Field>

        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SUBMITTING…' : 'SUBMIT LEAD'}</Button>
      </form>
      {result && (
        <div style={s.resultBox}>
          {result.error ? (
            <span style={{ color: 'var(--danger)' }}>{result.error}</span>
          ) : (
            <span style={{ color: 'var(--accent)' }}>Lead submitted — visible to the team now.</span>
          )}
        </div>
      )}
    </Card>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)' },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  section: { marginTop: 32 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  statsRow: { display: 'flex', gap: 32, marginBottom: 16, flexWrap: 'wrap' },
  breakdownCard: { marginBottom: 16 },
  breakdownTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 },
  noAssignmentBanner: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 14, borderRadius: 8, fontSize: 13, lineHeight: 1.5 },
  officesRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  officeChip: (active) => ({
    padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--accent-gradient-soft)' : 'var(--bg-elevated)', color: active ? 'var(--accent)' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'var(--border-accent)' : 'var(--border-hairline)'}`,
  }),
  split: { display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'start' },
  stacked: { display: 'flex', flexDirection: 'column', gap: 20 },
  formColumn: { minWidth: 0 },
  chatColumn: { position: 'sticky', top: 0, height: 640 },
  chatPlaceholder: { padding: 20, color: 'var(--text-muted)', fontStyle: 'italic' },
  formCard: { padding: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  formSectionTitle: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1.5, margin: '10px 0 2px', textTransform: 'uppercase' },
  liveTransferRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--warning)', background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', borderRadius: 8, padding: '8px 12px', margin: '4px 0 8px' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  resultBox: { marginTop: 12, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
};
