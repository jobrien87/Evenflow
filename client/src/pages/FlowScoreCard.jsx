import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// A real Flow Score card — reads a computed snapshot, never fabricates a
// number. Shows an honest "not enough activity yet" state instead of a
// fake score when nothing has been computed.
export default function FlowScoreCard({ scope = 'me', agencyId, title = 'FLOW SCORE', onViewReport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [scope, agencyId]);

  async function load() {
    try {
      const res = scope === 'agency' ? await api.agencyFlowScore(agencyId) : await api.myFlowScore();
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load Flow Score.');
    }
  }

  if (error) return <div style={s.card}><div style={s.error}>{error}</div></div>;
  if (!data) return <div style={s.card}><div style={s.muted}>Loading Flow Score…</div></div>;

  if (!data.snapshot) {
    return (
      <div style={s.card}>
        <div style={s.label}>{title}</div>
        <div style={s.emptyState}>{data.message || 'Not enough activity yet to compute a Flow Score.'}</div>
      </div>
    );
  }

  const { snapshot, explanation } = data;

  return (
    <div style={s.card}>
      <div style={s.headerRow}>
        <div style={s.label}>{title}</div>
        <div style={s.updated}>Updated {new Date(snapshot.computedAt).toLocaleString()}</div>
      </div>
      <div style={s.scoreRow}>
        <div style={s.score}>{snapshot.score}</div>
        <div style={s.scoreMax}>/ 100</div>
      </div>

      {explanation.strongestAreas.length > 0 && (
        <div style={s.section}>
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
        <div style={s.section}>
          <div style={s.sectionLabel}>BIGGEST OPPORTUNITY</div>
          {explanation.biggestOpportunities.map((c) => (
            <div key={c.label} style={s.driverRow}>
              <span>{c.label}{c.lowConfidence ? ' (limited data)' : ''}</span>
              <span style={s.driverValueNegative}>{c.value}%</span>
            </div>
          ))}
        </div>
      )}

      {explanation.excludedComponents.length > 0 && (
        <div style={s.excludedNote}>
          Not yet factored in (no data yet): {explanation.excludedComponents.map((c) => c.label).join(', ')}
        </div>
      )}

      {onViewReport && (
        <button style={s.viewReportLink} onClick={onViewReport}>View full report →</button>
      )}
    </div>
  );
}

const s = {
  card: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 20 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  label: { color: '#888', fontSize: 12, fontWeight: 700, letterSpacing: 1 },
  updated: { color: '#555', fontSize: 11 },
  scoreRow: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 16 },
  score: { color: '#00e5ff', fontSize: 40, fontWeight: 800, lineHeight: 1 },
  scoreMax: { color: '#555', fontSize: 14 },
  section: { marginBottom: 12 },
  sectionLabel: { color: '#666', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 },
  driverRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#ccc', padding: '4px 0' },
  driverValuePositive: { color: '#4dff88', fontWeight: 700 },
  driverValueNegative: { color: '#ffb84d', fontWeight: 700 },
  excludedNote: { color: '#555', fontSize: 11, marginTop: 8, fontStyle: 'italic' },
  viewReportLink: { marginTop: 12, background: 'none', border: 'none', color: '#00e5ff', fontSize: 12, cursor: 'pointer', padding: 0 },
  emptyState: { color: '#666', fontSize: 13, fontStyle: 'italic' },
  muted: { color: '#666', fontSize: 13 },
  error: { color: '#ff4d4d', fontSize: 13 },
};
