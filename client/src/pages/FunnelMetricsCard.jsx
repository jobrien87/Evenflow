import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, StatTile } from '../ui';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
  { key: 'today', label: 'Today', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
];

// Matches server/src/lib/firstAttemptSlaAlerts.js's FIRST_ATTEMPT_SLA_MINUTES
// default — the same "speed to lead is blown" line the real-time per-lead
// alert uses, so this card's own coloring agrees with what actually
// triggers a producer notification instead of picking an unrelated number.
const SLA_MINUTES = 30;

function formatHMS(minutes) {
  if (minutes == null) return null;
  const totalSeconds = Math.max(0, Math.round(minutes * 60));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// isDuration: true for the one non-percentage tile (speed to first
// attempt, HH:MM:SS) — a literal "0" there would misleadingly read as
// "instant," so it keeps the neutral dash and just says "No leads yet."
// Every percentage tile (contact/quote/close rate) shows an honest 0%
// instead, since "0 out of 0" is a fair, non-misleading starting value.
function Rate({ label, value, sampleSize, onClick, isDuration, tone }) {
  const clickable = onClick && sampleSize > 0;
  const sub = sampleSize === 0 ? 'No leads yet' : sampleSize < 3 ? `Limited data (${sampleSize})` : null;
  const displayValue = value !== null ? (isDuration ? value : `${value}%`) : isDuration ? '—' : '0%';
  return (
    <StatTile
      label={label}
      value={displayValue}
      sub={sub}
      tone={tone}
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

  const ZERO_FUNNEL = { totalLeads: 0, speedToFirstAttemptMedianMinutes: null, speedToFirstAttemptSampleSize: 0, contactRate: null, contactRateSampleSize: 0, quoteRate: null, quoteRateSampleSize: 0, closeRate: null, closeRateSampleSize: 0 };
  const primary = (scope === 'me' ? data.mine : data.agency) || ZERO_FUNNEL;
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
      <div style={s.ratesRow}>
        <Rate
          label="Speed to first attempt"
          value={formatHMS(primary.speedToFirstAttemptMedianMinutes)}
          sampleSize={primary.speedToFirstAttemptSampleSize}
          isDuration
          tone={primary.speedToFirstAttemptMedianMinutes !== null && primary.speedToFirstAttemptMedianMinutes > SLA_MINUTES ? 'danger' : undefined}
        />
        <Rate label="Contact rate" value={primary.contactRate} sampleSize={primary.contactRateSampleSize} onClick={onSelectStage && (() => onSelectStage('contacted', range))} />
        <Rate label="Quote rate" value={primary.quoteRate} sampleSize={primary.quoteRateSampleSize} onClick={onSelectStage && (() => onSelectStage('quoted', range))} />
        <Rate label="Close rate" value={primary.closeRate} sampleSize={primary.closeRateSampleSize} onClick={onSelectStage && (() => onSelectStage('sold', range))} />
      </div>
      {primary.totalLeads === 0 && <div style={s.comparisonNote}>No Leads Yet — these will fill in as leads come through this period.</div>}
      {comparison && comparison.totalLeads > 0 && (
        <div style={s.comparisonNote}>
          Agency average: {comparison.contactRate ?? '—'}% contact · {comparison.quoteRate ?? '—'}% quote · {comparison.closeRate ?? '—'}% close ({comparison.totalLeads} leads)
        </div>
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
