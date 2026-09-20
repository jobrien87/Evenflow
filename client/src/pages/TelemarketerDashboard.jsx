import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import FlowScoreCard from './FlowScoreCard';

const PRODUCTS = ['Auto', 'Home', 'Life', 'Health'];

export default function TelemarketerDashboard() {
  const [transfers, setTransfers] = useState([]);
  const [assignments, setAssignments] = useState(null);
  const [form, setForm] = useState({ product: 'Auto', state: '', firstName: '', lastName: '', phone: '', notes: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [data, assignmentData] = await Promise.all([api.transfers(), api.myAssignments()]);
    setTransfers(data.transfers);
    setAssignments(assignmentData.assignments);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await api.createTransfer({ ...form, state: form.state.toUpperCase() });
      setResult(res.transfer);
      setForm({ product: 'Auto', state: '', firstName: '', lastName: '', phone: '', notes: '' });
      await load();
    } catch (err) {
      setResult({ error: err.data?.message || err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <section style={s.section}>
        <FlowScoreCard scope="me" />
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>ASSIGNED OFFICES</h3>
        {assignments === null ? (
          <div style={s.empty}>Loading…</div>
        ) : assignments.length === 0 ? (
          <div style={s.noAssignmentBanner}>
            No offices are assigned yet. Contact Yield Operations before submitting leads, a submission has nowhere to route without an assignment.
          </div>
        ) : (
          <div style={s.officesRow}>
            {assignments.map((a) => (
              <div key={a.id} style={s.officeChip(a.agency.transfersEnabled && !a.agency.transferPaused)}>
                {a.agency.name}
                {!a.agency.transfersEnabled && ' (not accepting transfers)'}
                {a.agency.transfersEnabled && a.agency.transferPaused && ' (paused)'}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>SUBMIT QUALIFIED LEAD</h3>
        <form onSubmit={submit} style={s.form}>
          <select style={s.input} value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
            {PRODUCTS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input style={s.input} placeholder="State (2-letter, e.g. FL)" maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required />
          <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
          <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
          <input style={s.input} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <textarea style={{ ...s.input, minHeight: 60 }} placeholder="Notes / qualification details" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <button style={s.submitButton} disabled={busy} type="submit">
            {busy ? 'Routing…' : 'SUBMIT & ROUTE'}
          </button>
        </form>
        {result && (
          <div style={s.resultBox}>
            {result.error ? (
              <span style={{ color: 'var(--danger)' }}>{result.error}</span>
            ) : (
              <>
                <div style={s.resultStatus(result.status)}>{result.status.replace(/_/g, ' ')}</div>
                <div style={s.resultReason}>{result.routingReason}</div>
              </>
            )}
          </div>
        )}
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>MY RECENT TRANSFERS</h3>
        {transfers.map((t) => (
          <div key={t.id} style={s.row} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{t.firstName} {t.lastName} · {t.product} · {t.state}</div>
              <div style={s.rowSub}>{new Date(t.createdAt).toLocaleString()}</div>
            </div>
            <div style={s.badge(t.status)}>{t.status.replace(/_/g, ' ')}</div>
          </div>
        ))}
        {transfers.length === 0 && <div style={s.empty}>No transfers submitted yet.</div>}
      </section>
    </div>
  );
}

const bandColor = (status) => {
  if (['OFFERED', 'ACCEPTED', 'CONNECTED', 'COMPLETED', 'DISPOSITIONED'].includes(status)) return 'var(--accent)';
  if (['NO_ELIGIBLE_DESTINATION', 'REJECTED', 'MISSED', 'FAILED', 'CANCELLED'].includes(status)) return 'var(--danger)';
  return 'var(--warning)';
};

const s = {
  wrap: { color: 'var(--text-primary)' },
  section: { marginBottom: 32 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  noAssignmentBanner: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 14, borderRadius: 8, fontSize: 13, lineHeight: 1.5 },
  officesRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  officeChip: (healthy) => ({
    padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    background: healthy ? 'var(--accent-gradient-soft)' : 'var(--warning-soft)', color: healthy ? 'var(--accent)' : 'var(--warning)',
    border: `1px solid ${healthy ? 'var(--border-accent)' : 'rgba(255, 184, 77, 0.4)'}`,
  }),
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elevated)', padding: 20, borderRadius: 8, border: '1px solid var(--border-hairline)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  submitButton: { padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  resultBox: { marginTop: 12, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8 },
  resultStatus: (status) => ({ fontWeight: 700, color: bandColor(status) }),
  resultReason: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: (status) => ({ fontSize: 11, color: bandColor(status), border: `1px solid ${bandColor(status)}44`, padding: '4px 8px', borderRadius: 4 }),
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
