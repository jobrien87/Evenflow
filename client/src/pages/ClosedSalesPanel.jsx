import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, DateRangeFilter, EmptyState } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import { PRODUCT_META } from '../lib/productMeta';
import AddClosedSaleModal from './AddClosedSaleModal';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: 'year', label: 'This year', from: () => { const d = new Date(); return new Date(d.getFullYear(), 0, 1); } },
];

function money(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Closed Sales — the missing piece that actually lets anyone reach the
// real, already-working Sale correction backend (PATCH /sales/:id).
// Producer sees only their own sales (server-enforced); Owner/Manager
// see the whole agency with an optional producer filter. Clicking a row
// opens AddClosedSaleModal in edit mode.
export default function ClosedSalesPanel() {
  const { user } = useAuth();
  const isProducer = user?.role === 'PRODUCER';
  const [periodKey, setPeriodKey] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [producerFilter, setProducerFilter] = useState('');
  const [producers, setProducers] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingSale, setEditingSale] = useState(null);
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  // A real customer-name search — finds a Closed Sale by name regardless
  // of the selected date range, same convenience Find a Lead already
  // gives leads (see api.sales' ?q= handling server-side).
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');

  useEffect(() => {
    if (isProducer) return;
    api.users('').then((data) => setProducers(data.users.filter((u) => ['PRODUCER', 'AGENCY_MANAGER'].includes(u.role) && u.status === 'ACTIVE'))).catch(() => {});
  }, [isProducer]);

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, producerFilter, activeSearch]);

  async function load() {
    setError('');
    const params = new URLSearchParams();
    if (!isProducer && producerFilter) params.set('assignedToId', producerFilter);
    if (activeSearch) {
      params.set('q', activeSearch);
    } else {
      const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
      if (!range) return; // custom selected, dates not both picked yet
      params.set('from', range.from);
      params.set('to', range.to);
    }
    try {
      const data = await api.sales(`?${params.toString()}`);
      setSales(data.sales || []);
    } catch (err) {
      setError(err.data?.message || 'Could not load closed sales. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  function runSearch(e) {
    if (e) e.preventDefault();
    setActiveSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput('');
    setActiveSearch('');
  }

  const sortedSales = useMemo(() => {
    const val = (sale) => {
      if (sort.key === 'date') return new Date(sale.saleDate).getTime();
      if (sort.key === 'lsp') return sale.assignedTo ? `${sale.assignedTo.lastName} ${sale.assignedTo.firstName}`.toLowerCase() : '';
      if (sort.key === 'product') return (PRODUCT_META[sale.productFamily]?.label || sale.productFamily || '').toLowerCase();
      if (sort.key === 'carrier') return (sale.carrier || '').toLowerCase();
      if (sort.key === 'premium') return sale.premiumCents || 0;
      if (sort.key === 'items') return sale.items || 0;
      return '';
    };
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...sales].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * mult;
    });
  }, [sales, sort]);

  // Voided sales are listed but never counted toward totals.
  const totals = useMemo(() => sales.filter((x) => !x.voidedAt).reduce((acc, x) => ({
    items: acc.items + (x.items || 0),
    premiumCents: acc.premiumCents + (x.premiumCents || 0),
    count: acc.count + 1,
  }), { items: 0, premiumCents: 0, count: 0 }), [sales]);

  function toggleSort(key) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' || key === 'premium' || key === 'items' ? 'desc' : 'asc' }));
  }
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortHead = (key, label, style) => (
    <div style={{ ...style, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(key)}>{label}{arrow(key)}</div>
  );

  if (loading) return <div style={s.wrap}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>{isProducer ? 'MY SALES' : 'CLOSED SALES'} ({sales.length}){activeSearch ? ` · SEARCH: "${activeSearch}"` : ''}</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isProducer && (
            <select style={s.filterSelect} value={producerFilter} onChange={(e) => setProducerFilter(e.target.value)}>
              <option value="">All producers</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
          )}
          {!activeSearch && (
            <DateRangeFilter
              presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
              periodKey={periodKey}
              onSelectPreset={setPeriodKey}
              customFrom={customFrom}
              customTo={customTo}
              onCustomFromChange={setCustomFrom}
              onCustomToChange={setCustomTo}
            />
          )}
        </div>
      </div>

      <form onSubmit={runSearch} style={s.searchRow}>
        <input
          style={s.searchInput}
          placeholder="Search by customer name…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <Button type="submit" size="sm">SEARCH</Button>
        {activeSearch && <Button type="button" variant="secondary" size="sm" onClick={clearSearch}>CLEAR</Button>}
      </form>

      {editingSale && (
        <AddClosedSaleModal
          sale={editingSale}
          onClose={() => setEditingSale(null)}
          onSaved={() => { setEditingSale(null); load(); }}
        />
      )}

      {error && (
        <div style={s.loadErrorBox}>
          {error}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <Card>
        <SectionHeader>Sales</SectionHeader>
        {sales.length === 0 ? (
          <EmptyState title="No closed sales in this range" description="Add one from My Leads, Agency Leads, or Billboard." />
        ) : (
          <div style={s.table}>
            <div style={s.headerRowTable}>
              {sortHead('date', 'Date', s.colDate)}
              <div style={s.colCustomer}>Customer</div>
              {sortHead('carrier', 'Carrier / Policy', s.colPolicy)}
              {sortHead('product', 'Product', s.colProduct)}
              {sortHead('premium', 'Premium', s.colPremium)}
              {sortHead('items', 'Items', s.colItems)}
              {sortHead('lsp', 'Assigned To (LSP)', s.colAssigned)}
            </div>
            {sortedSales.map((sale) => (
              <div key={sale.id} style={s.row} onClick={() => setEditingSale(sale)}>
                <div style={s.colDate}>{new Date(sale.saleDate).toLocaleDateString()}</div>
                <div style={s.colCustomer}>{sale.firstName} {sale.lastName}</div>
                <div style={s.colPolicy}>{sale.carrier} — {sale.policyType}</div>
                <div style={s.colProduct}>{PRODUCT_META[sale.productFamily]?.label || sale.productFamily}</div>
                <div style={s.colPremium}>{money(sale.premiumCents)}</div>
                <div style={s.colItems}>{sale.items}</div>
                <div style={s.colAssigned}>
                  {sale.assignedTo ? `${sale.assignedTo.firstName} ${sale.assignedTo.lastName}` : '—'}
                  {sale.voidedAt && <Badge tone="danger" style={{ marginLeft: 8 }}>VOIDED</Badge>}
                </div>
              </div>
            ))}
            <div style={s.totalsRow}>
              <div style={s.colDate} />
              <div style={s.colCustomer}>TOTAL ({totals.count} sale{totals.count === 1 ? '' : 's'})</div>
              <div style={s.colPolicy} />
              <div style={s.colProduct} />
              <div style={s.colPremium}>{money(totals.premiumCents)}</div>
              <div style={s.colItems}>{totals.items}</div>
              <div style={s.colAssigned} />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

const s = {
  wrap: { padding: 20 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 18 },
  h3: { margin: 0, fontSize: 18, letterSpacing: 0.5 },
  filterSelect: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  searchRow: { display: 'flex', gap: 10, marginBottom: 14 },
  searchInput: { flex: 1, maxWidth: 360, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  retryButton: { background: 'transparent', border: '1px solid currentColor', color: 'inherit', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  table: { display: 'flex', flexDirection: 'column' },
  headerRowTable: { display: 'grid', gridTemplateColumns: '100px 1.3fr 1.3fr 1fr 110px 70px 1.2fr', gap: 10, padding: '8px 4px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-hairline)' },
  row: { display: 'grid', gridTemplateColumns: '100px 1.3fr 1.3fr 1fr 110px 70px 1.2fr', gap: 10, padding: '10px 4px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer' },
  totalsRow: { display: 'grid', gridTemplateColumns: '100px 1.3fr 1.3fr 1fr 110px 70px 1.2fr', gap: 10, padding: '12px 4px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', borderTop: '2px solid var(--border-strong)' },
  colDate: { color: 'var(--text-secondary)' },
  colCustomer: { fontWeight: 600 },
  colPolicy: { color: 'var(--text-secondary)' },
  colProduct: {},
  colPremium: { fontWeight: 600 },
  colItems: { color: 'var(--text-secondary)' },
  colAssigned: { display: 'flex', alignItems: 'center' },
};
