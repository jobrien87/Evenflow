import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ExportButton, EmptyState } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
];

const SORT_OPTIONS = [
  { key: 'totalLeads', label: 'Leads' },
  { key: 'quotedCount', label: 'Quoted' },
  { key: 'soldCount', label: 'Sold' },
  { key: 'cpa', label: 'CPA' },
];

function money(v) {
  return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
}

// Full, filterable zip-code performance report — reached from ZipCodeBox's
// "VIEW FULL REPORT" button, rendered by the caller as the same fixed
// overlay/modal shell RunningReportPage already uses (own data fetch,
// CLOSE handled by the parent, ExportButton + downloadCsv for CSV export).
export default function ZipReportPage({ agencyId, onClose }) {
  const [periodKey, setPeriodKey] = useState('month');
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('totalLeads');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, [periodKey, agencyId]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const period = PERIODS.find((p) => p.key === periodKey);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      const res = await api.zipReport(`?agencyId=${agencyId}&from=${from}&to=${to}`);
      setRows(res.rows);
    } catch (err) {
      setError(err.data?.message || 'Could not load the zip code report.');
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim();
    const list = q ? rows.filter((r) => r.zip.includes(q)) : rows;
    return [...list].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return bv - av;
    });
  }, [rows, search, sortKey]);

  function exportCsv() {
    downloadCsv('zip-code-performance', filtered, [
      { key: 'zip', label: 'Zip' },
      { key: 'totalLeads', label: 'Leads' },
      { key: 'quotedCount', label: 'Quoted' },
      { key: 'quoteRate', label: 'Quote Rate (%)' },
      { key: 'soldCount', label: 'Sold' },
      { key: 'closeRate', label: 'Close Rate (%)' },
      { key: 'costPerLead', label: 'Cost Per Lead ($)' },
      { key: 'cpa', label: 'CPA ($)' },
      { key: 'revenue', label: 'Revenue ($)' },
    ]);
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <div style={s.title}>ZIP CODE PERFORMANCE</div>
        <div style={s.headerActions}>
          <ExportButton onExport={exportCsv} />
          <button style={s.closeButton} onClick={onClose}>CLOSE</button>
        </div>
      </div>

      <div style={s.filterRow}>
        <div style={s.periodRow}>
          {PERIODS.map((p) => (
            <button key={p.key} style={p.key === periodKey ? s.periodButtonActive : s.periodButton} onClick={() => setPeriodKey(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        <input
          style={s.searchInput}
          placeholder="Filter by zip…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select style={s.sortSelect} value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
          {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>Sort by {o.label}</option>)}
        </select>
      </div>

      {error && <div style={s.error}>{error}</div>}

      {loading ? (
        <div style={s.empty}>Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No zip codes found" description={search ? 'No zip matches that filter.' : 'No leads with a zip code yet in this period.'} />
      ) : (
        <div style={s.tableCard}>
          <div style={s.tableHeaderRow}>
            <span>ZIP</span>
            <span>LEADS</span>
            <span>QUOTED</span>
            <span>QUOTE %</span>
            <span>SOLD</span>
            <span>CLOSE %</span>
            <span>COST/LEAD</span>
            <span>CPA</span>
            <span>REVENUE</span>
          </div>
          {filtered.map((r) => (
            <div key={r.zip} style={s.tableRow}>
              <span style={s.zipCell}>{r.zip}</span>
              <span>{r.totalLeads}</span>
              <span>{r.quotedCount}</span>
              <span>{r.quoteRate === null ? '—' : `${r.quoteRate}%`}</span>
              <span>{r.soldCount}</span>
              <span>{r.closeRate === null ? '—' : `${r.closeRate}%`}</span>
              <span>{money(r.costPerLead)}</span>
              <span>{money(r.cpa)}</span>
              <span>{money(r.revenue)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)', padding: 24, minWidth: 0 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 },
  title: { fontSize: 14, fontWeight: 700, letterSpacing: 1, color: 'var(--text-secondary)' },
  headerActions: { display: 'flex', gap: 8 },
  closeButton: {
    background: 'none', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-secondary)',
    fontSize: 12, fontWeight: 700, padding: '8px 14px', cursor: 'pointer',
  },
  filterRow: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  periodRow: { display: 'flex', gap: 6 },
  periodButton: {
    background: 'none', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-secondary)',
    fontSize: 12, padding: '7px 12px', cursor: 'pointer',
  },
  periodButtonActive: {
    background: 'var(--accent-gradient)', border: '1px solid var(--border-accent)', borderRadius: 6, color: 'var(--accent-on)',
    fontSize: 12, fontWeight: 700, padding: '7px 12px', cursor: 'pointer',
  },
  searchInput: { flex: 1, minWidth: 160, padding: '8px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  sortSelect: { padding: '8px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 13, marginBottom: 12 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', padding: 20 },
  tableCard: { border: '1px solid var(--border-hairline)', borderRadius: 8, overflow: 'hidden' },
  tableHeaderRow: {
    display: 'grid', gridTemplateColumns: '1fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr 1fr 1fr 1fr', padding: '10px 16px',
    fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)',
  },
  tableRow: {
    display: 'grid', gridTemplateColumns: '1fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr 1fr 1fr 1fr', padding: '10px 16px',
    fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)',
  },
  zipCell: { fontWeight: 600 },
};
