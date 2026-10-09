import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (isProducer) return;
    api.users('').then((data) => setProducers(data.users.filter((u) => ['PRODUCER', 'AGENCY_MANAGER'].includes(u.role) && u.status === 'ACTIVE'))).catch(() => {});
  }, [isProducer]);

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, producerFilter]);

  async function load() {
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (!isProducer && producerFilter) params.set('assignedToId', producerFilter);
      const data = await api.sales(`?${params.toString()}`);
      setSales(data.sales || []);
    } catch (err) {
      setError(err.data?.message || 'Could not load closed sales. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={s.wrap}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>{isProducer ? 'MY SALES' : 'CLOSED SALES'} ({sales.length})</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isProducer && (
            <select style={s.filterSelect} value={producerFilter} onChange={(e) => setProducerFilter(e.target.value)}>
              <option value="">All producers</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
          )}
          <DateRangeFilter
            presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
            periodKey={periodKey}
            onSelectPreset={setPeriodKey}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={setCustomFrom}
            onCustomToChange={setCustomTo}
          />
        </div>
      </div>

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
              <div style={s.colDate}>Date</div>
              <div style={s.colCustomer}>Customer</div>
              <div style={s.colPolicy}>Carrier / Policy</div>
              <div style={s.colProduct}>Product</div>
              <div style={s.colPremium}>Premium</div>
              <div style={s.colItems}>Items</div>
              <div style={s.colAssigned}>Assigned To</div>
            </div>
            {sales.map((sale) => (
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
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  retryButton: { background: 'transparent', border: '1px solid currentColor', color: 'inherit', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  table: { display: 'flex', flexDirection: 'column' },
  headerRowTable: { display: 'grid', gridTemplateColumns: '100px 1.3fr 1.3fr 1fr 110px 70px 1.2fr', gap: 10, padding: '8px 4px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-hairline)' },
  row: { display: 'grid', gridTemplateColumns: '100px 1.3fr 1.3fr 1fr 110px 70px 1.2fr', gap: 10, padding: '10px 4px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer' },
  colDate: { color: 'var(--text-secondary)' },
  colCustomer: { fontWeight: 600 },
  colPolicy: { color: 'var(--text-secondary)' },
  colProduct: {},
  colPremium: { fontWeight: 600 },
  colItems: { color: 'var(--text-secondary)' },
  colAssigned: { display: 'flex', alignItems: 'center' },
};
