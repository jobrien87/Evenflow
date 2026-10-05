import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, Modal, DateRangeFilter } from '../ui';
import { resolveDateRange } from '../lib/dateRange';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
  { key: 'today', label: 'Today', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
];

const TOP_N = 10;
const SCROLL_N = 75;
const ROW_HEIGHT = 34;

function money(v) {
  return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
}

// Top-of-Main-Stage KPI box, same period-toggle shell as LeadsSnapshotBox —
// shows the top 10 zips by lead volume without scrolling, and up to the
// top 75 in a scrollable list below that. "VIEW FULL REPORT" and "EMAIL
// REPORT" are handed off via props rather than owning their own overlay,
// same as FlowScoreCard's onViewReport pattern.
export default function ZipCodeBox({ agencyId, onViewReport, title = 'ZIP CODE PERFORMANCE' }) {
  const [periodKey, setPeriodKey] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [showEmail, setShowEmail] = useState(false);

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, agencyId]);

  async function load() {
    if (!agencyId) return;
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const res = await api.zipReport(`?agencyId=${agencyId}&from=${range.from}&to=${range.to}`);
      setRows(res.rows.slice(0, SCROLL_N));
    } catch (err) {
      setError(err.data?.message || 'Could not load the zip code report.');
    }
  }

  return (
    <Card>
      <SectionHeader
        right={
          <DateRangeFilter
            presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
            periodKey={periodKey}
            onSelectPreset={setPeriodKey}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={setCustomFrom}
            onCustomToChange={setCustomTo}
          />
        }
      >
        {title}
      </SectionHeader>

      {error && <div style={s.error}>{error}</div>}

      {rows.length === 0 && !error ? (
        <div style={s.empty}>No leads with a zip code yet in this period.</div>
      ) : (
        <>
          <div style={s.headerRow}>
            <span>ZIP</span>
            <span>LEADS</span>
            <span>QUOTED</span>
            <span>SOLD</span>
            <span>CPA</span>
          </div>
          <div style={{ ...s.scrollBody, maxHeight: TOP_N * ROW_HEIGHT }}>
            {rows.map((r) => (
              <div key={r.zip} style={s.row}>
                <span style={s.zipCell}>{r.zip}</span>
                <span>{r.totalLeads}</span>
                <span>{r.quotedCount}</span>
                <span>{r.soldCount}</span>
                <span>{money(r.cpa)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={s.footerRow}>
        <Button variant="secondary" size="sm" onClick={onViewReport}>VIEW FULL REPORT</Button>
        <Button variant="secondary" size="sm" onClick={() => setShowEmail(true)}>EMAIL REPORT</Button>
      </div>

      {showEmail && (
        <EmailZipReportModal
          agencyId={agencyId}
          periodKey={periodKey}
          customFrom={customFrom}
          customTo={customTo}
          onClose={() => setShowEmail(false)}
        />
      )}
    </Card>
  );
}

function EmailZipReportModal({ agencyId, periodKey, customFrom, customTo, onClose }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e) {
    e.preventDefault();
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) {
      setStatus('Pick both a start and end date first.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await api.emailZipReport(email, `?agencyId=${agencyId}&from=${range.from}&to=${range.to}`);
      setStatus(`Email status: ${res.emailStatus}`);
    } catch (err) {
      setStatus(err.data?.message || 'Failed to send report.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="EMAIL ZIP CODE REPORT" onClose={onClose}>
      <form onSubmit={send} style={s.form}>
        <label style={s.fieldLabel}>
          Vendor's email
          <input
            style={s.input}
            type="email"
            placeholder="vendor@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SENDING…' : 'SEND REPORT'}</Button>
        {status && <div style={s.status}>{status}</div>}
      </form>
    </Modal>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13, padding: '8px 0' },
  headerRow: {
    display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr', padding: '6px 4px',
    fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700,
    borderBottom: '1px solid var(--border-hairline)',
  },
  scrollBody: { overflowY: 'auto' },
  row: {
    display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr', padding: '8px 4px',
    fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)',
  },
  zipCell: { fontWeight: 600 },
  footerRow: { display: 'flex', gap: 8, marginTop: 14 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  status: { color: 'var(--text-secondary)', fontSize: 13 },
};
