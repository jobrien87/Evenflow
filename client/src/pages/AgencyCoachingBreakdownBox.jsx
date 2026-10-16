import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, DateRangeFilter } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import CoachingBreakdownResult from './CoachingBreakdownResult';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: '30d', label: 'Last 30 days', from: () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
];

// Main Stage dashboard widget — agency-wide Call Coaching Breakdown, via
// the new no-userId mode on GET /calls/coaching (routes/calls.js). Hides
// itself entirely (no error banner) when Sales Studio isn't unlocked for
// this agency, matching CallsPanel.jsx's own MODULE_NOT_ENTITLED handling.
export default function AgencyCoachingBreakdownBox() {
  const [period, setPeriod] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notEntitled, setNotEntitled] = useState(false);

  async function load() {
    const range = resolveDateRange(period, PERIODS, customFrom, customTo);
    if (!range) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.coachingBreakdown(`?from=${range.from}&to=${range.to}`);
      setResult(data);
    } catch (err) {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') {
        setNotEntitled(true);
      } else {
        setError(err.data?.message || 'Could not load the coaching breakdown.');
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  if (notEntitled) return null;

  return (
    <Card>
      <div style={s.headerRow}>
        <SectionHeader>Call Coaching Breakdown</SectionHeader>
        <DateRangeFilter
          presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
          periodKey={period}
          onSelectPreset={setPeriod}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>
      {error && <div style={s.error}>{error}</div>}
      {busy && !result && <div style={s.loading}>Loading…</div>}
      {result && <CoachingBreakdownResult result={result} emptyDescription="No analyzed calls agency-wide in this period yet." />}
    </Card>
  );
}

const s = {
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
};
