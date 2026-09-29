import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, ExportButton, EmptyState } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

function defaultFrom() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}
function fmtHours(minutes) {
  return (minutes / 60).toFixed(2);
}
function fmt(dt) {
  return dt ? new Date(dt).toLocaleString() : '—';
}

// Agency Owner/Manager only, per the user's explicit decision — everyone
// on the team clocks in/out, but only leadership sees the hours report.
export default function TimeClockReportPanel() {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, [from, to]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const data = await api.timeClockReport(`?from=${from}&to=${to}`);
      setEntries(data.entries);
    } catch (err) {
      setError(err.data?.message || 'Could not load the hours report. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    downloadCsv('hours-report', entries, [
      { key: (e) => `${e.firstName} ${e.lastName}`, label: 'Name' },
      { key: 'role', label: 'Role' },
      { key: 'date', label: 'Date' },
      { key: (e) => fmt(e.clockInAt), label: 'Clock In' },
      { key: (e) => fmt(e.clockOutAt), label: 'Clock Out' },
      { key: 'lunchMinutes', label: 'Lunch (min)' },
      { key: (e) => fmtHours(e.workedMinutes), label: 'Hours Worked' },
    ]);
  }

  const totalHours = entries.reduce((sum, e) => sum + e.workedMinutes, 0) / 60;

  return (
    <div style={s.wrap}>
      <SectionHeader
        right={
          <div style={s.controls}>
            <input style={s.dateInput} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span style={s.to}>to</span>
            <input style={s.dateInput} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <ExportButton onExport={exportCsv} />
          </div>
        }
      >
        HOURS REPORT
      </SectionHeader>

      {error && <div style={s.error}>{error}</div>}

      <Card>
        {loading ? (
          <div style={s.loading}>Loading…</div>
        ) : entries.length === 0 ? (
          <EmptyState title="No hours logged" description="No completed shifts in this date range yet." />
        ) : (
          <>
            <div style={s.totalRow}>Total: {totalHours.toFixed(2)} hours across {entries.length} shift{entries.length === 1 ? '' : 's'}</div>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Name</th>
                  <th style={s.th}>Role</th>
                  <th style={s.th}>Date</th>
                  <th style={s.th}>Clock In</th>
                  <th style={s.th}>Clock Out</th>
                  <th style={s.th}>Lunch</th>
                  <th style={s.th}>Hours</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td style={s.td}>{e.firstName} {e.lastName}</td>
                    <td style={s.td}>{e.role}</td>
                    <td style={s.td}>{e.date}</td>
                    <td style={s.td}>{fmt(e.clockInAt)}</td>
                    <td style={s.td}>{fmt(e.clockOutAt)}</td>
                    <td style={s.td}>{e.lunchMinutes} min</td>
                    <td style={s.td}>{fmtHours(e.workedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}

const s = {
  wrap: {},
  controls: { display: 'flex', alignItems: 'center', gap: 8 },
  dateInput: { padding: '6px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  to: { color: 'var(--text-muted)', fontSize: 12 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', padding: 16 },
  totalRow: { color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, marginBottom: 14 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, padding: '6px 10px', borderBottom: '1px solid var(--border-hairline)' },
  td: { padding: '8px 10px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)' },
};
