import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, StatTile, BarRow, Badge, ExportButton, EmptyState } from '../ui';
import { downloadCsv } from '../lib/downloadCsv';

const GRANULARITIES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

const money = (cents) => `$${((cents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// A real, wider inline line chart (not the compact Sparkline — this is
// the Billboard's headline visual, so it carries axis labels) built on
// the shared #accent-gradient stroke every other SVG primitive in this
// app already references.
function TrendLine({ series, height = 140 }) {
  if (!series || series.length < 2) return null;
  const width = Math.max(series.length * 48, 320);
  const max = Math.max(...series.map((p) => p.premiumCents), 1);
  const stepX = width / (series.length - 1);
  const coords = series.map((p, i) => `${i * stepX},${height - (p.premiumCents / max) * (height - 16)}`).join(' ');

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height + 24}>
        <polyline points={coords} fill="none" stroke="url(#accent-gradient)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {series.map((p, i) => (
          <circle key={p.date} cx={i * stepX} cy={height - (p.premiumCents / max) * (height - 16)} r={3} fill="var(--accent)" />
        ))}
        {series.map((p, i) => (
          i % Math.max(Math.ceil(series.length / 8), 1) === 0 && (
            <text key={`${p.date}-label`} x={i * stepX} y={height + 18} fontSize={10} fill="var(--text-muted)" textAnchor="middle">
              {p.date.slice(5)}
            </text>
          )
        ))}
      </svg>
    </div>
  );
}

// Billboard — the merged, promoted leaderboard tab: sold-item count and
// premium total by producer and by product line, plus a real time-series
// trend line, at whatever granularity (day/week/month/year) is selected.
// All data from GET /financials/billboard — no second, divergent "sale"
// computation.
export default function BillboardPanel() {
  const { user } = useAuth();
  const [granularity, setGranularity] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [granularity]);

  async function load() {
    setError('');
    try {
      const res = await api.billboard(`?granularity=${granularity}`);
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load the Billboard. Try refreshing.');
    }
  }

  if (error) return <EmptyState title="Couldn't load the Billboard" description={error} />;
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div>
      <div style={s.headerRow}>
        <SectionHeader>Billboard</SectionHeader>
        <div style={s.tabRow}>
          {GRANULARITIES.map((g) => (
            <button key={g.key} style={s.tab(granularity === g.key)} onClick={() => setGranularity(g.key)}>{g.label.toUpperCase()}</button>
          ))}
        </div>
      </div>

      <div style={s.statsRow}>
        <StatTile label="Sold" value={data.totals.soldCount} />
        <StatTile label="Premium Total" value={money(data.totals.premiumCents)} />
      </div>

      <Card style={s.card}>
        <div style={s.cardTitle}>TREND — PREMIUM BY {granularity.toUpperCase()}</div>
        <TrendLine series={data.series} />
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitleRow}>
          <div style={s.cardTitle}>PRODUCER LEADERBOARD</div>
          <ExportButton onExport={() => downloadCsv('billboard-producers', data.byProducer, [
            { key: 'firstName', label: 'First Name' },
            { key: 'lastName', label: 'Last Name' },
            { key: 'soldCount', label: 'Sold' },
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
              valueLabel={`${row.soldCount} · ${money(row.premiumCents)}`}
            />
          ))
        )}
      </Card>
    </div>
  );
}

const s = {
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  tabRow: { display: 'flex', gap: 8 },
  tab: (active) => ({
    padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: active ? 'var(--accent-gradient)' : 'transparent', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
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
