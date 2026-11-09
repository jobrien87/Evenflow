import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, EmptyState, Badge } from '../ui';

// Main Stage dashboard widget wrapping the already-built agency activity
// feed (GET /agencies/:agencyId/activity) — real audit-trail data that,
// until now, had no client surface rendering it anywhere.
export default function AgencyActivityFeedBox({ agencyId }) {
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!agencyId) return;
    api.agencyActivity(agencyId, '?pageSize=20')
      .then((data) => setActivity(data.activity || []))
      .catch((err) => setError(err.data?.message || 'Could not load the activity feed.'));
  }, [agencyId]);

  return (
    <Card>
      <SectionHeader>Agency Activity Feed</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!activity && !error && <div style={s.loading}>Loading…</div>}
      {activity && activity.length === 0 && (
        <EmptyState title="No activity yet" description="Actions taken on this agency will show up here." />
      )}
      {activity && activity.length > 0 && activity.map((e) => {
        const impersonatedBy = e.metadata?.impersonatedBy;
        return (
          <div key={e.id} style={s.row}>
            <span style={s.actionRow}>
              <span style={s.action}>{e.action.replace(/_/g, ' ').replace(/\./g, ' · ')}</span>
              {impersonatedBy && <Badge tone="warning">ADMIN ACTIVITY</Badge>}
            </span>
            <span style={s.meta}>
              {e.actor ? `${e.actor.firstName} ${e.actor.lastName}` : 'System'}
              {impersonatedBy && ` (via ${impersonatedBy.firstName} ${impersonatedBy.lastName}, Platform Owner)`}
              {' · '}{new Date(e.createdAt).toLocaleString()}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
  row: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' },
  actionRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  action: { fontSize: 13, color: 'var(--text-secondary)', textTransform: 'capitalize' },
  meta: { fontSize: 11, color: 'var(--text-muted)' },
};
