import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, SectionHeader, StatTile, Sparkline, BarRow, DateRangeFilter, EmptyState } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import { STATUS_COLOR, Section, List, ObjectionsList, ScoreGrid, ManagerReviewForm, TranscriptEntry } from './CallsPanel';
import FlowScoreSummaryCard from './FlowScoreSummaryCard';
import CoachingHelperSection from './CoachingHelperSection';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: '30d', label: 'Last 30 days', from: () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
];

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

function scoreTone(score) {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 80) return 'accent';
  if (score >= 60) return 'warning';
  return 'danger';
}

// The Call Scoring tab's real depth payoff: a single producer's complete
// coaching picture, not a flat calls table filtered by a dropdown. Every
// number here is real — most of it reused directly from the same places
// the regular Producer Detail page draws from (Flow Score, vendor/
// product KPIs, the coaching notes + AI summary helper) — plus a second,
// Call-Scoring-specific layer on top (score trend, drill category
// breakdown, recent calls with full detail, review/override activity)
// that the regular profile doesn't have. This is the Sales Studio upsell
// made visible: strictly more detail than what's free.
export default function CallScoringProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [periodKey, setPeriodKey] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [performance, setPerformance] = useState(null);
  const [callData, setCallData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [selectedCall, setSelectedCall] = useState(null);

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, userId]);

  async function load() {
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const [perfRes, callRes] = await Promise.all([
        api.userPerformance(userId, `?from=${range.from}&to=${range.to}`),
        api.callScoringProfile(userId, `?from=${range.from}&to=${range.to}`),
      ]);
      setPerformance(perfRes);
      setCallData(callRes);
    } catch (err) {
      setError(err.data?.message || 'Could not load this producer\'s Call Scoring profile. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function updatePhone(phone) {
    const res = await api.updateUser(userId, { phone });
    setPerformance((d) => ({ ...d, user: { ...d.user, phone: res.user.phone } }));
  }

  async function openCall(id) {
    setSelectedCallId(id);
    const data = await api.callDetail(id);
    setSelectedCall(data.call);
  }

  async function refreshSelectedCall() {
    const data = await api.callDetail(selectedCallId);
    setSelectedCall(data.call);
  }

  async function submitTranscript(transcript) {
    await api.submitCallTranscript(selectedCallId, transcript);
    await refreshSelectedCall();
    await load();
  }

  async function submitReview(overrideScore, comment) {
    await api.reviewCall(selectedCallId, {
      managerOverrideScore: overrideScore ? parseInt(overrideScore, 10) : undefined,
      managerComment: comment || undefined,
    });
    await refreshSelectedCall();
    await load();
  }

  async function retry(id) {
    await api.retryCall(id);
    await load();
  }

  if (loading) return <div style={s.wrap}>Loading…</div>;

  if (error || !performance || !callData) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {error || 'Could not load this producer.'}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      </div>
    );
  }

  const { user, snapshot, explanation, componentPlaceholders, vendorBreakdown, productBreakdown } = performance;
  const { coaching, recentCalls, scoreTrend, flaggedForReviewCount, managerOverrideCount } = callData;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>← BACK</Button>
          <h3 style={s.h3}>{user.firstName} {user.lastName}</h3>
          <div style={s.subtitle}>CALL SCORING PROFILE</div>
        </div>
        <DateRangeFilter
          presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
          periodKey={periodKey}
          onSelectPreset={setPeriodKey}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      <FlowScoreSummaryCard snapshot={snapshot} explanation={explanation} componentPlaceholders={componentPlaceholders} />

      <Card style={s.section}>
        <SectionHeader>Call Scoring</SectionHeader>
        {coaching.analyzedCallCount === 0 ? (
          <EmptyState title="No scored calls in this period" description={`${user.firstName} has no analyzed calls in the selected date range.`} />
        ) : (
          <>
            <div style={s.statsRow}>
              <StatTile label="Calls Analyzed" value={coaching.analyzedCallCount} sub={`of ${coaching.callCount} uploaded`} />
              <StatTile label="Avg Overall Score" value={coaching.averageOverallScore} />
              <StatTile label="Avg Drill Score" value={coaching.averageDrillScore} />
              {scoreTrend.length >= 2 && (
                <div style={s.trendTile}>
                  <div style={s.trendLabel}>TREND</div>
                  <Sparkline points={scoreTrend.map((p) => p.drillScore)} width={100} height={32} />
                </div>
              )}
              {flaggedForReviewCount > 0 && <StatTile label="Flagged for Review" value={flaggedForReviewCount} sub="manager eyes needed" />}
              {managerOverrideCount > 0 && <StatTile label="Manager Overrides" value={managerOverrideCount} sub="score adjusted by a manager" />}
            </div>

            <div style={{ marginTop: 20 }}>
              <div style={s.subLabel}>DRILL CATEGORY BREAKDOWN</div>
              {coaching.categoryBreakdown.map((c) => (
                <BarRow key={c.category} label={c.category} value={c.averageScore} valueLabel={`${c.averageScore} (${c.sampleSize} call${c.sampleSize === 1 ? '' : 's'})`} />
              ))}
            </div>

            <div style={{ marginTop: 20 }}>
              <div style={s.subLabel}>COACHING OPPORTUNITIES</div>
              {coaching.coachingOpportunities.length === 0 ? (
                <div style={s.emptySmall}>No categories below the coaching threshold — solid across the board.</div>
              ) : (
                coaching.coachingOpportunities.map((o) => (
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
          </>
        )}
      </Card>

      <section style={s.section}>
        <SectionHeader>Recent Calls ({recentCalls.length})</SectionHeader>
        {recentCalls.length === 0 ? (
          <EmptyState title="No calls this period" description="Nothing uploaded for this producer in the selected date range yet." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colName}>FILENAME</span>
              <span style={s.col}>STATUS</span>
              <span style={s.col}>OVERALL</span>
              <span style={s.col}>DRILL SCORE</span>
              <span style={s.col}>TOP STRENGTH</span>
              <span style={s.col}>WATCH FOR</span>
              <span style={s.col}>DATE</span>
            </div>
            {recentCalls.map((c) => (
              <div key={c.id} style={s.tableRow} onClick={() => openCall(c.id)}>
                <span style={s.colName}>
                  {c.filename}
                  {c.reviewRecommended && <Badge tone="danger" style={{ marginLeft: 6 }}>FLAGGED</Badge>}
                  {c.managerOverrideScore !== null && <Badge tone="warning" style={{ marginLeft: 6 }}>OVERRIDDEN</Badge>}
                </span>
                <span style={s.col}><Badge tone={c.status === 'COMPLETE' ? 'accent' : c.status === 'FAILED' ? 'danger' : 'neutral'}>{c.status}</Badge></span>
                <span style={s.col}>{c.overallScore !== null ? <Badge tone={scoreTone(c.overallScore)}>{c.overallScore}</Badge> : '—'}</span>
                <span style={s.col}>{c.drillScore !== null ? <Badge tone={scoreTone(c.drillScore)}>{c.drillScore}</Badge> : '—'}</span>
                <span style={s.colNote}>{c.topStrength || '—'}</span>
                <span style={s.colNote}>{c.topCoachingOpportunity || '—'}</span>
                <span style={s.col}>{new Date(c.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <SectionHeader>Where They're Struggling / Doing Great — By Vendor</SectionHeader>
        {(vendorBreakdown || []).length === 0 ? (
          <EmptyState title="No vendor leads this period" description="This producer hasn't received any vendor-sourced leads in the selected date range." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRowKpi}>
              <span style={s.colVendor}>VENDOR</span>
              <span style={s.col}>LEADS</span>
              <span style={s.col}>UNTOUCHED</span>
              <span style={s.col}>CONTACT%</span>
              <span style={s.col}>QUOTE%</span>
              <span style={s.col}>CLOSE%</span>
            </div>
            {vendorBreakdown.map((v) => (
              <div key={v.vendorId} style={s.tableRowKpi}>
                <span style={s.colVendor}>{v.vendorName}</span>
                <span style={s.col}>{v.totalLeads}</span>
                <span style={s.col}>{v.untouched}</span>
                <span style={s.col}>{pct(v.contactRate)}</span>
                <span style={s.col}>{pct(v.quoteRate)}</span>
                <span style={s.col}>{pct(v.closeRate)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <SectionHeader>By Lead Type / Product</SectionHeader>
        {(productBreakdown || []).length === 0 ? (
          <EmptyState title="No leads this period" description="Nothing to break down by product yet for this date range." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRowKpi}>
              <span style={s.colVendor}>PRODUCT</span>
              <span style={s.col}>LEADS</span>
              <span style={s.col}>CONTACT%</span>
              <span style={s.col}>QUOTE%</span>
              <span style={s.col}>CLOSE%</span>
              <span style={s.col}>SALES</span>
            </div>
            {productBreakdown.map((p) => (
              <div key={p.product} style={s.tableRowKpi}>
                <span style={s.colVendor}>{p.product}</span>
                <span style={s.col}>{p.totalLeads}</span>
                <span style={s.col}>{pct(p.contactRate)}</span>
                <span style={s.col}>{pct(p.quoteRate)}</span>
                <span style={s.col}>{pct(p.closeRate)}</span>
                <span style={s.col}>{p.salesCount}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <CoachingHelperSection userId={userId} user={user} onPhoneSaved={updatePhone} />

      {selectedCall && (
        <div style={s.modalOverlay} onClick={() => { setSelectedCall(null); setSelectedCallId(null); }}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.headerRow}>
              <h3 style={s.h3Modal}>{selectedCall.filename}</h3>
              <button style={s.closeButton} onClick={() => { setSelectedCall(null); setSelectedCallId(null); }}>CLOSE</button>
            </div>

            <div style={s.statusLine}>
              Status: <span style={{ color: STATUS_COLOR[selectedCall.status] }}>{selectedCall.status}</span>
            </div>

            <audio style={s.audioPlayer} controls crossOrigin="use-credentials" src={api.callAudioUrl(selectedCall.id)} />

            {selectedCall.status === 'FAILED' && (
              <div style={s.failureBox}>
                {selectedCall.failureReason}
                <button style={s.retryButtonFull} onClick={() => { retry(selectedCall.id); setSelectedCall(null); setSelectedCallId(null); }}>RETRY PROCESSING</button>
              </div>
            )}

            {['UPLOADED', 'QUEUED', 'TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING'].includes(selectedCall.status) && (
              <div style={s.progressBox}>Processing… this updates automatically every few seconds.</div>
            )}

            {!selectedCall.transcript ? (
              <TranscriptEntry onSubmit={submitTranscript} />
            ) : (
              <Section title="Full Transcript" content={<pre style={s.transcript}>{selectedCall.transcript}</pre>} />
            )}

            {selectedCall.analysis && (
              <div>
                <div style={s.overallScoreRow}>
                  <div style={s.overallScoreValue}>{selectedCall.analysis.overallScore}</div>
                  <div style={s.overallScoreLabel}>OVERALL SCORE</div>
                  {selectedCall.drillScore !== null && selectedCall.drillScore !== undefined && (
                    <>
                      <div style={{ ...s.overallScoreValue, fontSize: 28, color: 'var(--text-secondary)' }}>{selectedCall.drillScore}</div>
                      <div style={s.overallScoreLabel}>DRILL SCORE</div>
                    </>
                  )}
                </div>

                {selectedCall.drillCategoryScores && (
                  <Section title="Drill Category Scores" content={
                    <div>
                      {selectedCall.drillCategoryScores.map((c) => (
                        <BarRow key={c.category} label={c.category} value={c.score} />
                      ))}
                    </div>
                  } />
                )}

                <Section title="Summary" content={<p style={s.text}>{selectedCall.analysis.summary}</p>} />
                <Section title="Dimension Scores" content={<ScoreGrid scores={selectedCall.analysis.dimensionScores} />} />
                <Section title="Strengths" content={<List items={selectedCall.analysis.strengths} />} />
                <Section title="Coaching Opportunities" content={<List items={selectedCall.analysis.coachingOpportunities} />} />

                {['AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'].includes(currentUser.role) && (
                  <ManagerReviewForm analysis={selectedCall.analysis} onSubmit={submitReview} />
                )}

                <Section title="Objections" content={<ObjectionsList items={selectedCall.analysis.objections} />} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: {},
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-primary)', fontSize: 22, fontFamily: 'var(--font-display)', marginTop: 4 },
  subtitle: { color: 'var(--accent)', fontSize: 10, fontWeight: 700, letterSpacing: 2, marginTop: 2 },
  section: { marginBottom: 24 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' },
  trendTile: { display: 'flex', flexDirection: 'column', gap: 6 },
  trendLabel: { fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, fontWeight: 700 },
  subLabel: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' },
  emptySmall: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  opportunityRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12, marginBottom: 8 },
  opportunityTitle: { fontWeight: 600, fontSize: 13 },
  opportunitySub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1.6fr 1.6fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1.6fr 1.6fr 1fr', padding: '12px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', alignItems: 'center' },
  tableHeaderRowKpi: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRowKpi: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)' },
  colName: { fontWeight: 600 },
  colNote: { color: 'var(--text-secondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colVendor: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 },
  modal: { background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
  h3Modal: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  statusLine: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 },
  audioPlayer: { width: '100%', marginBottom: 16 },
  failureBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 14, borderRadius: 8, fontSize: 13, marginBottom: 16 },
  retryButtonFull: { display: 'block', marginTop: 10, padding: '8px 14px', background: 'var(--danger)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  progressBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 14, borderRadius: 8, fontSize: 13 },
  overallScoreRow: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 },
  overallScoreValue: { fontSize: 36, fontWeight: 800, color: 'var(--accent)' },
  overallScoreLabel: { fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 1, marginRight: 16 },
  text: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 },
  transcript: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, padding: 12, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' },
};
