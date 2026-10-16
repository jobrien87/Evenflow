import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, StatTile, EmptyState } from '../ui';

// Main Stage dashboard widget — agency-wide Break Room engagement, via
// the new GET /break-room/agency-summary route. Shows a muted note
// instead of stats when Break Room isn't enabled for this agency.
export default function BreakRoomEngagementBox() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.breakRoomAgencySummary()
      .then(setData)
      .catch((err) => setError(err.data?.message || 'Could not load Break Room engagement.'));
  }, []);

  return (
    <Card>
      <SectionHeader>Break Room Engagement</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!data && !error && <div style={s.loading}>Loading…</div>}
      {data && !data.enabled && (
        <EmptyState title="Break Room isn't enabled" description="Ask your platform contact to turn on Break Room for this agency." />
      )}
      {data && data.enabled && (
        <>
          <div style={s.statsRow}>
            <StatTile label="Sessions This Week" value={data.sessionsThisWeek} />
            <StatTile label="Sessions This Month" value={data.sessionsThisMonth} />
            <StatTile label="Achievements" value={data.achievementsAllTime} sub={`${data.achievementsThisMonth} this month`} />
          </div>
          {data.topScorer && (
            <div style={s.callout}>
              Top Scorer: <strong>{data.topScorer.firstName} {data.topScorer.lastName}</strong> — {data.topScorer.bestScore} pts ({data.topScorer.gameType})
            </div>
          )}
          {data.mostActiveThisWeek && (
            <div style={s.callout}>
              Most Active This Week: <strong>{data.mostActiveThisWeek.firstName} {data.mostActiveThisWeek.lastName}</strong> ({data.mostActiveThisWeek.sessionCount} sessions)
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
  statsRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  callout: { fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 },
};
