import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, BarRow, EmptyState } from '../ui';

// Main Stage dashboard widget — the full Agency Flow Score component
// breakdown (all components, not just the strongest-area/opportunity
// highlight FlowScoreCard shows). Pure client work: GET /flow-score/agency
// already returns snapshot.components/excludedComponents in full.
export default function FlowScoreBreakdownCard({ agencyId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!agencyId) return;
    api.agencyFlowScore(agencyId).then(setData).catch((err) => setError(err.data?.message || 'Could not load the Flow Score breakdown.'));
  }, [agencyId]);

  return (
    <Card>
      <SectionHeader>Flow Score — Full Breakdown</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!data && !error && <div style={s.loading}>Loading…</div>}
      {data && !data.snapshot && (
        <EmptyState title="Not enough activity yet" description={data.message || 'Keep working leads — the breakdown appears once there is enough data.'} />
      )}
      {data && data.snapshot && (
        <>
          {[...data.snapshot.components].sort((a, b) => b.value - a.value).map((c) => (
            <BarRow key={c.key} label={c.label} value={c.value} valueLabel={`${c.value}%`} />
          ))}
          {data.snapshot.excludedComponents?.length > 0 && (
            <div style={s.excludedNote}>
              Not yet factored in (no data yet): {data.snapshot.excludedComponents.map((c) => c.label).join(', ')}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
  excludedNote: { color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic', marginTop: 10 },
};
