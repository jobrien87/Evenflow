import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, StatTile, BarRow, EmptyState } from '../ui';

// Main Stage dashboard widget — agency-wide training completion rollup,
// via the new GET /training/rollup route. Hides itself (no error banner)
// when Sales Studio isn't unlocked for this agency.
export default function TrainingRollupBox() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notEntitled, setNotEntitled] = useState(false);

  useEffect(() => {
    api.trainingRollup()
      .then(setData)
      .catch((err) => {
        if (err.data?.error === 'MODULE_NOT_ENTITLED') setNotEntitled(true);
        else setError(err.data?.message || 'Could not load training completion.');
      });
  }, []);

  if (notEntitled) return null;

  return (
    <Card>
      <SectionHeader>Training Completion</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {!data && !error && <div style={s.loading}>Loading…</div>}
      {data && data.totalAssignments === 0 && (
        <EmptyState title="No training assigned yet" description="Assigned courses and their completion will show up here." />
      )}
      {data && data.totalAssignments > 0 && (
        <>
          <div style={s.statsRow}>
            <StatTile label="Total Assignments" value={data.totalAssignments} />
            <StatTile label="Completed" value={data.completedAssignments} />
            <StatTile label="Completion" value={data.overallCompletionPercent != null ? `${data.overallCompletionPercent}%` : '—'} />
          </div>
          <div style={{ marginTop: 16 }}>
            {data.byCourse.map((c) => (
              <BarRow key={c.courseId} label={c.title} value={c.completionPercent ?? 0} valueLabel={`${c.completed}/${c.total}`} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

const s = {
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
  loading: { color: 'var(--text-muted)', fontSize: 13 },
  statsRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
};
