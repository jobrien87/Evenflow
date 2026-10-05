import { Card, SectionHeader, ProgressRing } from '../ui';

// The Flow Score ring + strongest-area/biggest-opportunity explanation —
// shared by ProducerDetailPage and CallScoringProfilePage so both
// producer-drill-down pages show the same real score, computed once,
// never two divergent renderings of the same snapshot.
export default function FlowScoreSummaryCard({ snapshot, explanation, componentPlaceholders }) {
  return (
    <Card style={s.section}>
      <SectionHeader>FLOW SCORE</SectionHeader>
      {!snapshot ? (
        <>
          <div style={s.scoreRow}>
            <ProgressRing value={null} size={88} strokeWidth={7} />
            <div style={s.driversWrap}>
              <div style={s.sectionLabel}>WHAT THIS TRACKS</div>
              {(componentPlaceholders || []).map((c) => (
                <div key={c.key} style={s.driverRow}>
                  <span>{c.label}</span>
                  <span style={s.noDataYet}>No data yet</span>
                </div>
              ))}
            </div>
          </div>
          <div style={s.excludedNote}>Not enough activity yet to compute a Flow Score.</div>
        </>
      ) : (
        <>
          <div style={s.scoreRow}>
            <ProgressRing value={snapshot.score} size={88} strokeWidth={7} />
            <div style={s.driversWrap}>
              {explanation.strongestAreas.length > 0 && (
                <div>
                  <div style={s.sectionLabel}>STRONGEST AREA</div>
                  {explanation.strongestAreas.map((c) => (
                    <div key={c.label} style={s.driverRow}>
                      <span>{c.label}{c.lowConfidence ? ' (limited data)' : ''}</span>
                      <span style={s.driverValuePositive}>{c.value}%</span>
                    </div>
                  ))}
                </div>
              )}
              {explanation.biggestOpportunities.length > 0 && (
                <div>
                  <div style={s.sectionLabel}>BIGGEST OPPORTUNITY</div>
                  {explanation.biggestOpportunities.map((c) => (
                    <div key={c.label} style={s.driverRow}>
                      <span>{c.label}{c.lowConfidence ? ' (limited data)' : ''}</span>
                      <span style={s.driverValueNegative}>{c.value}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {explanation.excludedComponents.length > 0 && (
            <div style={s.excludedNote}>
              Not yet factored in (no data yet): {explanation.excludedComponents.map((c) => c.label).join(', ')}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const s = {
  section: { marginBottom: 24 },
  scoreRow: { display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' },
  driversWrap: { flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 12 },
  sectionLabel: { color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 },
  driverRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' },
  driverValuePositive: { color: 'var(--accent)', fontWeight: 700 },
  driverValueNegative: { color: 'var(--warning)', fontWeight: 700 },
  noDataYet: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  excludedNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 8, fontStyle: 'italic' },
};
