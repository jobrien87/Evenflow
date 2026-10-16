import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, EmptyState } from '../ui';

// Main Stage dashboard widget — agency-wide upcoming work anniversaries
// (next 30 days), via the new GET /roster/anniversaries route. Mirrors
// RosterSettingsPanel.jsx's own birthday-row layout.
export default function WorkAnniversariesBox() {
  const [anniversaries, setAnniversaries] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.rosterAnniversaries()
      .then((data) => setAnniversaries(data.anniversaries || []))
      .catch((err) => setError(err.data?.message || 'Could not load upcoming anniversaries.'));
  }, []);

  return (
    <Card>
      <SectionHeader>Upcoming Work Anniversaries</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!anniversaries && !error && <div style={s.loading}>Loading…</div>}
      {anniversaries && anniversaries.length === 0 && (
        <EmptyState title="Nothing in the next 30 days" description="Upcoming work anniversaries will show up here." />
      )}
      {anniversaries && anniversaries.length > 0 && anniversaries.map((a) => (
        <div key={a.id} style={s.row}>
          <span>{a.firstName} {a.lastName}</span>
          <span style={s.meta}>{a.yearsOfService}-yr · {a.daysUntil === 0 ? 'today' : `in ${a.daysUntil}d`}</span>
        </div>
      ))}
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
  row: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' },
  meta: { fontSize: 11, color: 'var(--text-muted)' },
};
