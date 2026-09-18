import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
  { key: 'today', label: 'Today', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
];

function Rate({ label, value, sampleSize, onClick }) {
  const clickable = onClick && sampleSize > 0;
  return (
    <div style={s.rate(clickable)} onClick={clickable ? onClick : undefined}>
      <div style={s.rateValue}>{value === null ? '—' : `${value}%`}</div>
      <div style={s.rateLabel}>{label}</div>
      {sampleSize < 3 && sampleSize > 0 && <div style={s.lowSample}>limited data ({sampleSize})</div>}
      {sampleSize === 0 && <div style={s.lowSample}>no data yet</div>}
    </div>
  );
}

// scope: 'me' (Producer, shows "you vs. agency") or 'agency' (Agency Owner).
// onSelectStage(stage, { from, to }), when passed, makes each rate a link to
// the exact leads behind it — same date window and grouping the rate itself
// used, so the drill-down list is never a fabricated or approximate subset.
export default function FunnelMetricsCard({ scope = 'me', title = 'FUNNEL', onSelectStage }) {
  const [periodKey, setPeriodKey] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(null);

  useEffect(() => {
    load();
  }, [periodKey, scope]);

  async function load() {
    try {
      const period = PERIODS.find((p) => p.key === periodKey);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      setRange({ from, to });
      const res = await api.leadFunnel(`?scope=${scope}&from=${from}`);
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load funnel metrics.');
    }
  }

  if (error) return <div style={s.card}><div style={s.error}>{error}</div></div>;
  if (!data) return <div style={s.card}><div style={s.muted}>Loading…</div></div>;

  const primary = scope === 'me' ? data.mine : data.agency;
  const comparison = scope === 'me' ? data.agency : null;

  return (
    <div style={s.card}>
      <div style={s.headerRow}>
        <div style={s.label}>{title}</div>
        <div style={s.periodRow}>
          {PERIODS.map((p) => (
            <button key={p.key} style={s.periodButton(p.key === periodKey)} onClick={() => setPeriodKey(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {!primary || primary.totalLeads === 0 ? (
        <div style={s.emptyState}>No leads in this period yet.</div>
      ) : (
        <>
          <div style={s.ratesRow}>
            <Rate label="Speed to first attempt" value={primary.speedToFirstAttemptMedianMinutes !== null ? Math.round(primary.speedToFirstAttemptMedianMinutes) : null} sampleSize={primary.speedToFirstAttemptSampleSize} />
            <Rate label="Contact rate" value={primary.contactRate} sampleSize={primary.contactRateSampleSize} onClick={onSelectStage && (() => onSelectStage('contacted', range))} />
            <Rate label="Quote rate" value={primary.quoteRate} sampleSize={primary.quoteRateSampleSize} onClick={onSelectStage && (() => onSelectStage('quoted', range))} />
            <Rate label="Close rate" value={primary.closeRate} sampleSize={primary.closeRateSampleSize} onClick={onSelectStage && (() => onSelectStage('sold', range))} />
          </div>
          {comparison && comparison.totalLeads > 0 && (
            <div style={s.comparisonNote}>
              Agency average: {comparison.contactRate ?? '—'}% contact · {comparison.quoteRate ?? '—'}% quote · {comparison.closeRate ?? '—'}% close ({comparison.totalLeads} leads)
            </div>
          )}
        </>
      )}
    </div>
  );
}

const s = {
  card: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 20 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 },
  label: { color: '#888', fontSize: 12, fontWeight: 700, letterSpacing: 1 },
  periodRow: { display: 'flex', gap: 6 },
  periodButton: (active) => ({
    padding: '4px 10px', borderRadius: 4, border: '1px solid #333', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: active ? '#00e5ff' : 'transparent', color: active ? '#000' : '#888',
  }),
  ratesRow: { display: 'flex', gap: 20, flexWrap: 'wrap' },
  rate: (clickable) => ({ minWidth: 100, cursor: clickable ? 'pointer' : 'default' }),
  rateValue: { color: '#00e5ff', fontSize: 24, fontWeight: 800 },
  rateLabel: { color: '#888', fontSize: 11, marginTop: 2 },
  lowSample: { color: '#555', fontSize: 10, fontStyle: 'italic', marginTop: 2 },
  comparisonNote: { color: '#666', fontSize: 12, marginTop: 14, borderTop: '1px solid #1a1a1a', paddingTop: 10 },
  emptyState: { color: '#666', fontSize: 13, fontStyle: 'italic' },
  muted: { color: '#666', fontSize: 13 },
  error: { color: '#ff4d4d', fontSize: 13 },
};
