import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, StatTile, BarRow, Badge, Button, ExportButton, EmptyState, TrendChart, MonthSelector } from '../ui';
import { money } from '../lib/format';
import { downloadCsv } from '../lib/downloadCsv';
import AddClosedSaleModal from './AddClosedSaleModal';

const PERIODS = [
  { key: 'week', label: 'WEEK' },
  { key: 'month', label: 'MONTH' },
  { key: 'year', label: 'YEAR' },
  { key: 'all_years', label: 'ALL YEARS' },
];

// Billboard — the merged, promoted leaderboard tab: sold-item count and
// premium total by producer and by product line, plus a real time-series
// trend chart, for a fixed Eastern-time calendar period (Week/Month/Year/
// All Years — see server/src/lib/billboardPeriods.js). All data from
// GET /financials/billboard?period=... — no second, divergent "sale"
// computation. A single fetched `data` object backs every stat tile, the
// trend chart, and all four breakdown cards below, so changing the
// period always updates everything together, by construction.
export default function BillboardPanel() {
  const { user } = useAuth();
  const [period, setPeriod] = useState('month');
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [selectedYear, setSelectedYear] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showAddSale, setShowAddSale] = useState(false);
  // Guards against a slow earlier request resolving after a faster, newer
  // one and clobbering its result (e.g. rapidly switching periods) — only
  // the response from the most recently fired request is ever applied.
  const requestIdRef = useRef(0);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, selectedMonth, selectedYear]);

  function selectPeriod(key) {
    setPeriod(key);
    if (key !== 'month') setSelectedMonth(null);
    if (key !== 'year') setSelectedYear(null);
  }

  async function load() {
    const requestId = ++requestIdRef.current;
    setError('');
    try {
      const params = new URLSearchParams({ period });
      if (period === 'month' && selectedMonth) {
        params.set('month', `${selectedMonth.year}-${String(selectedMonth.month).padStart(2, '0')}`);
      }
      if (period === 'year' && selectedYear) {
        params.set('year', String(selectedYear));
      }
      const res = await api.billboard(`?${params.toString()}`);
      if (requestId !== requestIdRef.current) return;
      setData(res);
      // Adopt the server's own default exactly once per period switch
      // (while still null) — never on every load, since a fresh object
      // reference on every call would otherwise retrigger this same
      // effect indefinitely (selectedMonth/selectedYear are both effect
      // dependencies).
      if (period === 'month' && !selectedMonth && res.selectedMonth) setSelectedMonth(res.selectedMonth);
      if (period === 'year' && !selectedYear && res.selectedYear) setSelectedYear(res.selectedYear);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err.data?.message || 'Could not load the Billboard. Try refreshing.');
    }
  }

  if (error) return <EmptyState title="Couldn't load the Billboard" description={error} />;
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  const showTrend = period === 'week' || period === 'year' || period === 'all_years';

  return (
    <div>
      <div style={s.headerRow}>
        <SectionHeader>Billboard</SectionHeader>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => setShowAddSale(true)}>+ ADD CLOSED SALE</Button>
          <div style={s.periodTabs}>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => selectPeriod(p.key)}
                style={{ ...s.periodBtn, ...(period === p.key ? s.periodBtnActive : {}) }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showAddSale && (
        <AddClosedSaleModal onClose={() => setShowAddSale(false)} onSaved={load} />
      )}

      <div style={s.periodLabel}>{data.periodLabel}</div>

      {period === 'month' && (
        <MonthSelector months={data.availableMonths || []} selected={data.selectedMonth} onSelect={setSelectedMonth} />
      )}

      <div style={s.statsRow}>
        <StatTile
          label="Sold"
          value={data.totals.soldCount}
          sub={data.historicalRecordsIncluded > 0 ? `includes ${data.historicalRecordsIncluded} historical` : undefined}
        />
        {/* Items (sum of Sale.items/HistoricalRecord.items) is a distinct
            count from the policy/row count above — a single policy can
            carry several items (e.g. a multi-car or multi-line sale),
            so this is never assumed to equal soldCount. */}
        <StatTile
          label="Items"
          value={data.totals.itemCount}
          sub={data.totals.unknownItemsCount > 0 ? `${data.totals.unknownItemsCount} unknown — needs reconciliation` : undefined}
        />
        <StatTile label="Premium Total" value={money(data.totals.premiumCents)} />
      </div>

      {showTrend && (
        <Card style={s.card}>
          <div style={s.cardTitle}>TREND — PREMIUM BY {period === 'week' ? 'DAY' : period === 'year' ? 'MONTH' : 'YEAR'}</div>
          <TrendChart series={data.series} />
        </Card>
      )}

      <Card style={s.card}>
        <div style={s.cardTitleRow}>
          <div style={s.cardTitle}>PRODUCER LEADERBOARD</div>
          <ExportButton onExport={() => downloadCsv('billboard-producers', data.byProducer, [
            { key: 'firstName', label: 'First Name' },
            { key: 'lastName', label: 'Last Name' },
            { key: 'soldCount', label: 'Policies Sold' },
            { key: 'itemCount', label: 'Items' },
            { key: 'unknownItemsCount', label: 'Unknown Items' },
            { key: (r) => (r.premiumCents / 100).toFixed(2), label: 'Premium ($)' },
          ])} />
        </div>
        {data.byProducer.length === 0 ? (
          <div style={s.empty}>No sales in this period yet.</div>
        ) : (
          data.byProducer.map((row, i) => (
            <div key={row.userId} style={s.row} className="ui-row-stack">
              <div style={s.rowLeft}>
                <Badge tone={i === 0 ? 'accent' : 'neutral'}>{`#${i + 1}`}</Badge>
                <span style={s.rowName}>
                  {row.firstName} {row.lastName}
                  {row.userId === user?.id && <span style={s.youTag}> (you)</span>}
                </span>
              </div>
              <div style={s.rowRight}>
                <span style={s.rowStat}>{row.soldCount} sold</span>
                <span style={s.rowStat}>{row.itemCount} items</span>
                <span style={s.rowStat}>{money(row.premiumCents)}</span>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitle}>BY PRODUCT LINE</div>
        {data.byProduct.length === 0 ? (
          <div style={s.empty}>No sales in this period yet.</div>
        ) : (
          data.byProduct.map((row) => (
            <BarRow
              key={row.product}
              label={row.label}
              value={row.soldCount}
              max={data.totals.soldCount || 1}
              valueLabel={`${row.soldCount} sold · ${row.itemCount} items · ${money(row.premiumCents)}`}
            />
          ))
        )}
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitleRow}>
          <div style={s.cardTitle}>BY VENDOR</div>
          <ExportButton onExport={() => downloadCsv('billboard-by-vendor', data.byVendor, [
            { key: 'vendorName', label: 'Vendor' },
            { key: 'soldCount', label: 'Policies Sold' },
            { key: 'itemCount', label: 'Items' },
            { key: 'unknownItemsCount', label: 'Unknown Items' },
            { key: (r) => (r.premiumCents / 100).toFixed(2), label: 'Premium ($)' },
          ])} />
        </div>
        {data.byVendor.length === 0 ? (
          <div style={s.empty}>No sales in this period yet.</div>
        ) : (
          data.byVendor.map((row) => (
            <BarRow
              key={row.vendorId || 'direct'}
              label={row.vendorName}
              value={row.soldCount}
              max={data.totals.soldCount || 1}
              valueLabel={`${row.soldCount} sold · ${row.itemCount} items · ${money(row.premiumCents)}`}
            />
          ))
        )}
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitleRow}>
          <div style={s.cardTitle}>BY ZIP CODE</div>
          <ExportButton onExport={() => downloadCsv('billboard-by-zip', data.byZip, [
            { key: 'zip', label: 'Zip' },
            { key: 'soldCount', label: 'Policies Sold' },
            { key: 'itemCount', label: 'Items' },
            { key: 'unknownItemsCount', label: 'Unknown Items' },
            { key: (r) => (r.premiumCents / 100).toFixed(2), label: 'Premium ($)' },
          ])} />
        </div>
        {data.byZip.length === 0 ? (
          <div style={s.empty}>No sales in this period yet.</div>
        ) : (
          data.byZip.map((row) => (
            <BarRow
              key={row.zip}
              label={row.zip}
              value={row.soldCount}
              max={data.totals.soldCount || 1}
              valueLabel={`${row.soldCount} sold · ${row.itemCount} items · ${money(row.premiumCents)}`}
            />
          ))
        )}
      </Card>
    </div>
  );
}

const s = {
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  periodTabs: { display: 'flex', gap: 4, border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 3 },
  periodBtn: { padding: '6px 12px', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, cursor: 'pointer' },
  periodBtnActive: { background: 'var(--accent-gradient-soft)', color: 'var(--accent)' },
  periodLabel: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 20 },
  card: { marginBottom: 16, padding: 'var(--space-4)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cardTitle: { fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-hairline)', gap: 10 },
  rowLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  rowName: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  youTag: { color: 'var(--accent)', fontSize: 12, fontWeight: 400 },
  rowRight: { display: 'flex', gap: 16 },
  rowStat: { fontSize: 13, color: 'var(--text-secondary)' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
