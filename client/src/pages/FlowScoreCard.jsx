import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, SectionHeader, ProgressRing, Button } from '../ui';
import FlowSettingsModal from './FlowSettingsModal';

const WEIGHT_EDITOR_ROLES = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'];

// A real Flow Score card — reads a computed snapshot, never fabricates a
// number. Shows an honest "not enough activity yet" state instead of a
// fake score when nothing has been computed.
export default function FlowScoreCard({ scope = 'me', agencyId, title = 'FLOW SCORE', onViewReport }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const canEditWeights = scope === 'agency' && agencyId && WEIGHT_EDITOR_ROLES.includes(user?.role);
  const settingsButton = canEditWeights && (
    <Button variant="secondary" size="sm" onClick={() => setShowSettings(true)}>
      FLOW SETTINGS
    </Button>
  );

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

  if (error) return <Card><div style={s.error}>{error}</div></Card>;
  if (!data) return <Card><div style={s.muted}>Loading Flow Score…</div></Card>;

  if (!data.snapshot) {
    return (
      <Card data-tour="flow-score">
        <SectionHeader right={settingsButton}>{title}</SectionHeader>
        <div style={s.scoreRow}>
          <ProgressRing value={null} size={88} strokeWidth={7} />
          <div style={s.driversWrap}>
            <div style={s.section}>
              <div style={s.sectionLabel}>WHAT THIS TRACKS</div>
              {(data.componentPlaceholders || []).map((c) => (
                <div key={c.key} style={s.driverRow}>
                  <span>{c.label}</span>
                  <span style={s.noDataYet}>No data yet</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={s.excludedNote}>{data.message || 'Not enough activity yet to compute a Flow Score.'}</div>
        {onViewReport && (
          <Button variant="ghost" style={{ marginTop: 12 }} onClick={onViewReport}>
            View full report →
          </Button>
        )}
        {showSettings && <FlowSettingsModal agencyId={agencyId} onClose={() => setShowSettings(false)} />}
      </Card>
    );
  }

  const { snapshot, explanation } = data;

  return (
    <Card data-tour="flow-score">
      <SectionHeader
        right={
          <div style={s.headerRight}>
            {settingsButton}
            <span style={s.updated}>Updated {new Date(snapshot.computedAt).toLocaleString()}</span>
          </div>
        }
      >
        {title}
      </SectionHeader>

      <div style={s.scoreRow}>
        <ProgressRing value={snapshot.score} size={88} strokeWidth={7} />
        <div style={s.driversWrap}>
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
        </div>
      </div>

      {explanation.excludedComponents.length > 0 && (
        <div style={s.excludedNote}>
          Not yet factored in (no data yet): {explanation.excludedComponents.map((c) => c.label).join(', ')}
        </div>
      )}

      {onViewReport && (
        <Button variant="ghost" style={{ marginTop: 12 }} onClick={onViewReport}>
          View full report →
        </Button>
      )}
      {showSettings && <FlowSettingsModal agencyId={agencyId} onClose={() => setShowSettings(false)} />}
    </Card>
  );
}

const s = {
  headerRight: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' },
  updated: { color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 },
  scoreRow: { display: 'flex', alignItems: 'center', gap: 24, marginBottom: 16, flexWrap: 'wrap' },
  driversWrap: { flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 12 },
  section: {},
  sectionLabel: { color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 },
  driverRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' },
  driverValuePositive: { color: 'var(--accent)', fontWeight: 700 },
  driverValueNegative: { color: 'var(--warning)', fontWeight: 700 },
  noDataYet: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  excludedNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 8, fontStyle: 'italic' },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 13 },
};
