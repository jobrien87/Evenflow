import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// A real-time assembly view over data that already persists elsewhere
// (Flow Score snapshots, funnel metrics, call analysis, goals) — every
// number here is read from, or computed by, the same source the
// standalone cards use. Nothing is recalculated a second, divergent way.
export default function RunningReportPage({ scope = 'me', agencyId, onClose }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [scope, agencyId]);

  async function load() {
    try {
      const res = scope === 'agency' ? await api.agencyRunningReport(agencyId) : await api.myRunningReport();
      setReport(res.report);
    } catch (err) {
      setError(err.data?.message || 'Could not load the running report.');
    }
  }

  if (error) return <div style={s.wrap}><div style={s.error}>{error}</div></div>;
  if (!report) return <div style={s.wrap}><div style={s.muted}>Loading report…</div></div>;

  const { flowScore, funnel, goals } = report;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h2 style={s.h2}>{scope === 'agency' ? 'AGENCY RUNNING REPORT' : 'MY RUNNING REPORT'}</h2>
        {onClose && <button style={s.closeButton} onClick={onClose}>CLOSE</button>}
      </div>

      <section style={s.section}>
        <div style={s.sectionLabel}>FLOW SCORE</div>
        {!flowScore.current ? (
          <div style={s.emptyState}>Not enough activity yet to compute a Flow Score.</div>
        ) : (
          <>
            <div style={s.scoreRow}>
              <div style={s.score}>{flowScore.current.score}</div>
              <div style={s.scoreMax}>/ 100</div>
            </div>
            {flowScore.trend.length > 1 && (
              <div style={s.trendRow}>
                {flowScore.trend.map((snap) => (
                  <div key={snap.id} style={s.trendBar(snap.score)} title={`${snap.score} on ${new Date(snap.computedAt).toLocaleDateString()}`} />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section style={s.section}>
        <div style={s.sectionLabel}>FUNNEL (THIS MONTH)</div>
        {!funnel || funnel.totalLeads === 0 ? (
          <div style={s.emptyState}>No leads this month yet.</div>
        ) : (
          <div style={s.ratesRow}>
            <Rate label="Contact rate" value={funnel.contactRate} sampleSize={funnel.contactRateSampleSize} />
            <Rate label="Quote rate" value={funnel.quoteRate} sampleSize={funnel.quoteRateSampleSize} />
            <Rate label="Close rate" value={funnel.closeRate} sampleSize={funnel.closeRateSampleSize} />
          </div>
        )}
      </section>

      {scope === 'me' && (
        <section style={s.section}>
          <div style={s.sectionLabel}>RECENT CALLS</div>
          {report.recentCalls.length === 0 ? (
            <div style={s.emptyState}>No analyzed calls yet.</div>
          ) : (
            report.recentCalls.map((c) => (
              <div key={c.id} style={s.callRow}>
                <div style={s.callHeader}>
                  <span style={s.callScore}>{c.overallScore}/100</span>
                  <span style={s.callDate}>{new Date(c.createdAt).toLocaleDateString()}</span>
                </div>
                {Array.isArray(c.strengths) && c.strengths.length > 0 && (
                  <div style={s.callDetail}><b>Strengths:</b> {c.strengths.join(', ')}</div>
                )}
                {Array.isArray(c.coachingOpportunities) && c.coachingOpportunities.length > 0 && (
                  <div style={s.callDetail}><b>Coaching:</b> {c.coachingOpportunities.join(', ')}</div>
                )}
              </div>
            ))
          )}
        </section>
      )}

      {scope === 'agency' && (
        <section style={s.section}>
          <div style={s.sectionLabel}>TEAM</div>
          {report.roster.length === 0 ? (
            <div style={s.emptyState}>No active producers yet.</div>
          ) : (
            report.roster.map((p) => (
              <div key={p.id} style={s.rosterRow}>
                <span>{p.firstName} {p.lastName}</span>
                <span style={s.rosterScore}>
                  {p.score === null ? '—' : `${p.score}/100`}
                  {p.trend && <span style={s.trendArrow(p.trend)}>{p.trend === 'UP' ? ' ▲' : p.trend === 'DOWN' ? ' ▼' : ' ▬'}</span>}
                </span>
              </div>
            ))
          )}
        </section>
      )}

      <section style={s.section}>
        <div style={s.sectionLabel}>GOALS</div>
        {goals.length === 0 ? (
          <div style={s.emptyState}>No active goals for this period.</div>
        ) : (
          goals.map((g) => (
            <div key={g.id} style={s.goalRow}>
              <div style={s.goalHeader}>
                <span>{g.metric.replace(/_/g, ' ')}</span>
                <span>{g.actual ?? '—'} / {g.targetValue}</span>
              </div>
              <div style={s.goalBarTrack}>
                <div style={s.goalBarFill(Math.min(100, g.progressPercent ?? 0))} />
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function Rate({ label, value, sampleSize }) {
  return (
    <div style={s.rate}>
      <div style={s.rateValue}>{value === null ? '—' : `${value}%`}</div>
      <div style={s.rateLabel}>{label}</div>
      {sampleSize < 3 && sampleSize > 0 && <div style={s.lowSample}>limited data ({sampleSize})</div>}
    </div>
  );
}

const s = {
  wrap: { color: 'var(--text-primary)', maxWidth: 640, margin: '0 auto', padding: 24 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  h2: { fontWeight: 400, color: 'var(--text-primary)', letterSpacing: 1, fontSize: 18 },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  section: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 10, padding: 20, marginBottom: 20 },
  sectionLabel: { color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 12 },
  scoreRow: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 12 },
  score: { color: 'var(--accent)', fontSize: 40, fontWeight: 800, lineHeight: 1 },
  scoreMax: { color: 'var(--text-muted)', fontSize: 14 },
  trendRow: { display: 'flex', gap: 4, alignItems: 'flex-end', height: 32 },
  trendBar: (score) => ({ width: 10, height: `${Math.max(4, score) / 100 * 32}px`, background: 'var(--border-accent)', borderRadius: 2 }),
  ratesRow: { display: 'flex', gap: 24, flexWrap: 'wrap' },
  rate: { minWidth: 90 },
  rateValue: { color: 'var(--accent)', fontSize: 22, fontWeight: 800 },
  rateLabel: { color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 },
  lowSample: { color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic', marginTop: 2 },
  callRow: { borderTop: '1px solid var(--border-hairline)', padding: '10px 0' },
  callHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  callScore: { color: 'var(--accent)', fontWeight: 700, fontSize: 13 },
  callDate: { color: 'var(--text-muted)', fontSize: 11 },
  callDetail: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 },
  rosterRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border-hairline)', fontSize: 13 },
  rosterScore: { color: 'var(--accent)', fontWeight: 700 },
  trendArrow: (trend) => ({ color: trend === 'UP' ? 'var(--accent)' : trend === 'DOWN' ? 'var(--danger)' : 'var(--text-secondary)', fontSize: 11 }),
  goalRow: { marginBottom: 14 },
  goalHeader: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'capitalize' },
  goalBarTrack: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 4, height: 8, overflow: 'hidden' },
  goalBarFill: (pct) => ({ width: `${pct}%`, height: '100%', background: 'var(--accent)' }),
  emptyState: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 13 },
};
