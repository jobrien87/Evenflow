import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Button, StatTile } from '../ui';

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
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, agencyId]);

  async function load() {
    if (!agencyId) return;
    setError('');
    try {
      const period = PERIODS.find((p) => p.key === periodKey);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      const res = await api.leadsSnapshot(`?agencyId=${agencyId}&from=${from}&to=${to}`);
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
  periodRow: { display: 'flex', gap: 6 },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  statsGrid: { display: 'flex', gap: 24, flexWrap: 'wrap' },
};
