import { StatTile, BarRow, Badge, EmptyState } from '../ui';

// Shared "coaching breakdown" result rendering — used by both
// CallScoringPanel.jsx's Coaching Box (Owner/Manager, any producer) and
// CallsPanel.jsx's own self-service breakdown (Producer, always their
// own). One canonical rendering of api.coachingBreakdown()'s result,
// never two divergent copies.
export default function CoachingBreakdownResult({ result, emptyDescription }) {
  if (result.analyzedCallCount === 0) {
    return (
      <EmptyState
        title="No scored calls in this period"
        description={emptyDescription || 'No analyzed calls in the selected period yet.'}
      />
    );
  }

  return (
    <div>
      <div style={s.statsRow}>
        <StatTile label="Calls Analyzed" value={result.analyzedCallCount} sub={`of ${result.callCount} uploaded`} />
        <StatTile label="Avg Overall Score" value={result.averageOverallScore} />
        <StatTile label="Avg Drill Score" value={result.averageDrillScore} />
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={s.subLabel}>DRILL CATEGORY BREAKDOWN</div>
        {result.categoryBreakdown.map((c) => (
          <BarRow key={c.category} label={c.category} value={c.averageScore} valueLabel={`${c.averageScore} (${c.sampleSize} call${c.sampleSize === 1 ? '' : 's'})`} />
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={s.subLabel}>COACHING OPPORTUNITIES</div>
        {result.coachingOpportunities.length === 0 ? (
          <div style={s.emptySmall}>No categories below the coaching threshold — solid across the board.</div>
        ) : (
          result.coachingOpportunities.map((o) => (
            <div key={o.category} style={s.opportunityRow}>
              <div>
                <div style={s.opportunityTitle}>{o.category}</div>
                <div style={s.opportunitySub}>Averaging {o.averageScore} across {o.sampleSize} call{o.sampleSize === 1 ? '' : 's'}</div>
              </div>
              {o.courseTitle && <Badge tone="warning">Practice: {o.courseTitle}</Badge>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const s = {
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  subLabel: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' },
  emptySmall: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  opportunityRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12, marginBottom: 8 },
  opportunityTitle: { fontWeight: 600, fontSize: 13 },
  opportunitySub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
};
