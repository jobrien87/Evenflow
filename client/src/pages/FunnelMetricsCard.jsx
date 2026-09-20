import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, StatTile, EmptyState } from '../ui';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
  { key: 'today', label: 'Today', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
];

function Rate({ label, value, sampleSize, onClick }) {
  const clickable = onClick && sampleSize > 0;
  const sub = sampleSize === 0 ? 'no data yet' : sampleSize < 3 ? `limited data (${sampleSize})` : null;
  return (
    <StatTile
      label={label}
      value={value === null ? '—' : `${value}%`}
      sub={sub}
      onClick={clickable ? onClick : undefined}
    />
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

  if (error) return <Card><div style={s.error}>{error}</div></Card>;
  if (!data) return <Card><div style={s.muted}>Loading…</div></Card>;

  const primary = scope === 'me' ? data.mine : data.agency;
  const comparison = scope === 'me' ? data.agency : null;

  return (
    <Card>
      <SectionHeader
        right={
          <div style={s.periodRow}>
            {PERIODS.map((p) => (
              <Button key={p.key} size="sm" variant={p.key === periodKey ? 'primary' : 'secondary'} onClick={() => setPeriodKey(p.key)}>
                {p.label}
              </Button>
            ))}
          </div>
        }
      >
        {title}
      </SectionHeader>
      {!primary || primary.totalLeads === 0 ? (
        <EmptyState description="No leads in this period yet." />
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
    </Card>
  );
}

const s = {
  periodRow: { display: 'flex', gap: 6 },
  ratesRow: { display: 'flex', gap: 20, flexWrap: 'wrap' },
  comparisonNote: { color: 'var(--text-muted)', fontSize: 12, marginTop: 14, borderTop: '1px solid var(--border-hairline)', paddingTop: 10 },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 13 },
};
