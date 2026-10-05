import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, StatTile, DateRangeFilter } from '../ui';
import { resolveDateRange } from '../lib/dateRange';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
  { key: 'today', label: 'Today', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
];

const ZERO = { totalLeads: 0, inMoshpit: 0, untouched: 0, quoted: 0, sold: 0 };

// Same "never blank" rule as FunnelMetricsCard/FlowScoreCard — every number
// here always renders, starting at a real 0, never collapsing to an empty
// state just because nothing has happened yet in the selected period.
export default function LeadsSnapshotBox({ agencyId, title = 'LEADS SNAPSHOT' }) {
  const [periodKey, setPeriodKey] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, agencyId]);

  async function load() {
    if (!agencyId) return;
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const res = await api.leadsSnapshot(`?agencyId=${agencyId}&from=${range.from}&to=${range.to}`);
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load leads snapshot.');
    }
  }

  const snapshot = data || ZERO;

  return (
    <Card>
      <SectionHeader
        right={
          <DateRangeFilter
            presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
            periodKey={periodKey}
            onSelectPreset={setPeriodKey}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={setCustomFrom}
            onCustomToChange={setCustomTo}
          />
        }
      >
        {title}
      </SectionHeader>

      {error && <div style={s.error}>{error}</div>}

      <div style={s.statsGrid}>
        <StatTile label="Total Leads" tone="white" value={snapshot.totalLeads} />
        <StatTile label="In Moshpit" value={snapshot.inMoshpit} sub={snapshot.inMoshpit > 0 ? 'unclaimed right now' : undefined} />
        <StatTile label="Untouched" value={snapshot.untouched} sub={snapshot.untouched > 0 ? 'no attempt yet' : undefined} />
        <StatTile label="Quoted" tone="green" value={snapshot.quoted} />
        <StatTile label="Sold" tone="lime" value={snapshot.sold} />
      </div>
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  statsGrid: { display: 'flex', gap: 24, flexWrap: 'wrap' },
};
