import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, Badge, Button, StatTile, SectionHeader, EmptyState, BarRow, FileDropzone } from '../ui';
import { STATUS_COLOR, Section, List, ObjectionsList, ScoreGrid, ManagerReviewForm, TranscriptEntry } from './CallsPanel';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: '30d', label: 'Last 30 days', from: () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
];

function scoreTone(score) {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 80) return 'accent';
  if (score >= 60) return 'warning';
  return 'danger';
}

// Every producer in the agency roster who has ever uploaded/been attributed
// a call needs to appear in the sort/filter dropdowns, so this reads from
// the same real user roster AgencyOwnerDashboard already fetches — not a
// second, narrower producer list.
export default function CallScoringPanel() {
  const { user } = useAuth();
  const [producers, setProducers] = useState([]);
  const [calls, setCalls] = useState([]);
  const [notEntitled, setNotEntitled] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [filterProducerId, setFilterProducerId] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  const [uploadProducerId, setUploadProducerId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadedNote, setUploadedNote] = useState('');

  const [selectedCall, setSelectedCall] = useState(null);

  const [coachProducerId, setCoachProducerId] = useState('');
  const [coachPeriod, setCoachPeriod] = useState('month');
  const [coachResult, setCoachResult] = useState(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachError, setCoachError] = useState('');

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const [usersData, callsData] = await Promise.all([api.users(''), api.calls()]);
      setProducers(usersData.users.filter((u) => u.role === 'PRODUCER' && u.status === 'ACTIVE'));
      setCalls(callsData.calls);
      setNotEntitled(false);
    } catch (err) {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') {
        setNotEntitled(true);
      } else {
        setLoadError(err.data?.message || 'Could not load Call Scoring. Try refreshing.');
      }
    }
  }

  if (notEntitled) {
    return (
      <div style={s.notEntitledBox}>
        Sales Coaching isn't included on your current plan. Check the Billing tab, or ask your platform contact to enable it.
      </div>
    );
  }

  async function handleUploadFile(file) {
    if (!uploadProducerId) {
      setUploadError('Pick which producer this call belongs to first.');
      return;
    }
    setUploading(true);
    setUploadError('');
    setUploadedNote('');
    try {
      await api.uploadCall(file, null, uploadProducerId);
      setUploadedNote('Uploaded — it will appear below once transcribed and scored.');
      await load();
    } catch (err) {
      setUploadError(err.data?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function viewCall(id) {
    const data = await api.callDetail(id);
    setSelectedCall(data.call);
  }

  async function retry(id) {
    await api.retryCall(id);
    await load();
  }

  async function submitTranscript(transcript) {
    await api.submitCallTranscript(selectedCall.id, transcript);
    const data = await api.callDetail(selectedCall.id);
    setSelectedCall(data.call);
    await load();
  }

  async function submitReview(overrideScore, comment) {
    await api.reviewCall(selectedCall.id, {
      managerOverrideScore: overrideScore ? parseInt(overrideScore, 10) : undefined,
      managerComment: comment || undefined,
    });
    const data = await api.callDetail(selectedCall.id);
    setSelectedCall(data.call);
    await load();
  }

  async function generateCoaching() {
    if (!coachProducerId) {
      setCoachError('Pick a producer first.');
      return;
    }
    setCoachBusy(true);
    setCoachError('');
    setCoachResult(null);
    try {
      const period = PERIODS.find((p) => p.key === coachPeriod);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      const data = await api.coachingBreakdown(`?userId=${coachProducerId}&from=${from}&to=${to}`);
      setCoachResult(data);
    } catch (err) {
      setCoachError(err.data?.message || 'Could not generate the coaching breakdown.');
    } finally {
      setCoachBusy(false);
    }
  }

  function producerName(id) {
    const p = producers.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'Unknown';
  }

  const visibleCalls = calls
    .filter((c) => !filterProducerId || c.uploadedBy?.id === filterProducerId)
    .slice()
    .sort((a, b) => {
      const an = `${a.uploadedBy?.firstName || ''} ${a.uploadedBy?.lastName || ''}`;
      const bn = `${b.uploadedBy?.firstName || ''} ${b.uploadedBy?.lastName || ''}`;
      return sortDir === 'asc' ? an.localeCompare(bn) : bn.localeCompare(an);
    });

  return (
    <div style={s.wrap}>
      {loadError && (
        <div style={s.loadErrorBox}>
          {loadError}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}

      <section style={s.section}>
        <SectionHeader>Upload a Call</SectionHeader>
        <Card>
          <div style={s.uploadRow}>
            <label style={s.fieldLabel}>
              Producer
              <select style={s.select} value={uploadProducerId} onChange={(e) => setUploadProducerId(e.target.value)}>
                <option value="">Select a producer…</option>
                {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
              </select>
            </label>
          </div>
          <FileDropzone
            onFile={handleUploadFile}
            disabled={uploading || !uploadProducerId}
            accept="audio/*,video/mp4"
            label={uploading ? 'Uploading…' : 'Click to upload, or drag a call recording here'}
            hint={!uploadProducerId ? 'Select a producer above first' : 'Audio or video — it will be transcribed and scored automatically'}
          />
          {uploadError && <div style={s.error}>{uploadError}</div>}
          {uploadedNote && <div style={s.success}>{uploadedNote}</div>}
        </Card>
      </section>

      <section style={s.section}>
        <div style={s.headerRow}>
          <SectionHeader>Calls ({visibleCalls.length})</SectionHeader>
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={s.select} value={filterProducerId} onChange={(e) => setFilterProducerId(e.target.value)}>
              <option value="">All producers</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
          </div>
        </div>

        {visibleCalls.length === 0 ? (
          <EmptyState title="No calls scored yet" description="Upload a recorded call above to get a Drill Score for it." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colName}>FILENAME</span>
              <span style={s.colProducer} onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}>
                PRODUCER {sortDir === 'asc' ? '▲' : '▼'}
              </span>
              <span style={s.col}>STATUS</span>
              <span style={s.col}>OVERALL</span>
              <span style={s.col}>DRILL SCORE</span>
              <span style={s.col}>DATE</span>
            </div>
            {visibleCalls.map((c) => (
              <div key={c.id} style={s.tableRow} onClick={() => viewCall(c.id)}>
                <span style={s.colName}>{c.filename}</span>
                <span style={s.colProducer}>{c.uploadedBy ? `${c.uploadedBy.firstName} ${c.uploadedBy.lastName}` : '—'}</span>
                <span style={s.col}><Badge tone={c.status === 'COMPLETE' ? 'accent' : c.status === 'FAILED' ? 'danger' : 'neutral'}>{c.status}</Badge></span>
                <span style={s.col}>{c.analysis ? <Badge tone={scoreTone(c.analysis.overallScore)}>{c.analysis.overallScore}</Badge> : '—'}</span>
                <span style={s.col}>{c.drillScore !== null && c.drillScore !== undefined ? <Badge tone={scoreTone(c.drillScore)}>{c.drillScore}</Badge> : '—'}</span>
                <span style={s.col}>{new Date(c.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <SectionHeader>Coaching Box</SectionHeader>
        <Card>
          <div style={s.coachRow}>
            <label style={s.fieldLabel}>
              Producer
              <select style={s.select} value={coachProducerId} onChange={(e) => setCoachProducerId(e.target.value)}>
                <option value="">Select a producer…</option>
                {producers.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
              </select>
            </label>
            <label style={s.fieldLabel}>
              Period
              <select style={s.select} value={coachPeriod} onChange={(e) => setCoachPeriod(e.target.value)}>
                {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
            <Button variant="primary" onClick={generateCoaching} disabled={coachBusy}>
              {coachBusy ? 'GENERATING…' : 'GENERATE BREAKDOWN'}
            </Button>
          </div>
          {coachError && <div style={s.error}>{coachError}</div>}

          {coachResult && (
            <div style={s.coachResult}>
              {coachResult.analyzedCallCount === 0 ? (
                <EmptyState
                  title="No scored calls in this period"
                  description={`${producerName(coachProducerId)} has no analyzed calls in the selected period yet.`}
                />
              ) : (
                <>
                  <div style={s.statsRow}>
                    <StatTile label="Calls Analyzed" value={coachResult.analyzedCallCount} sub={`of ${coachResult.callCount} uploaded`} />
                    <StatTile label="Avg Overall Score" value={coachResult.averageOverallScore} />
                    <StatTile label="Avg Drill Score" value={coachResult.averageDrillScore} />
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <div style={s.subLabel}>DRILL CATEGORY BREAKDOWN</div>
                    {coachResult.categoryBreakdown.map((c) => (
                      <BarRow key={c.category} label={c.category} value={c.averageScore} valueLabel={`${c.averageScore} (${c.sampleSize} call${c.sampleSize === 1 ? '' : 's'})`} />
                    ))}
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <div style={s.subLabel}>COACHING OPPORTUNITIES</div>
                    {coachResult.coachingOpportunities.length === 0 ? (
                      <div style={s.emptySmall}>No categories below the coaching threshold — solid across the board.</div>
                    ) : (
                      coachResult.coachingOpportunities.map((o) => (
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
            </div>
          )}
        </Card>
      </section>

      {selectedCall && (
        <div style={s.modalOverlay} onClick={() => setSelectedCall(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.headerRow}>
              <h3 style={s.h3}>{selectedCall.filename}</h3>
              <button style={s.closeButton} onClick={() => setSelectedCall(null)}>CLOSE</button>
            </div>

            <div style={s.statusLine}>
              Status: <span style={{ color: STATUS_COLOR[selectedCall.status] }}>{selectedCall.status}</span>
              {selectedCall.uploadedBy && <> · {selectedCall.uploadedBy.firstName} {selectedCall.uploadedBy.lastName}</>}
            </div>

            <audio style={s.audioPlayer} controls crossOrigin="use-credentials" src={api.callAudioUrl(selectedCall.id)} />

            {selectedCall.status === 'FAILED' && (
              <div style={s.failureBox}>
                {selectedCall.failureReason}
                <button style={s.retryButtonFull} onClick={() => { retry(selectedCall.id); setSelectedCall(null); }}>RETRY PROCESSING</button>
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

                {['AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'].includes(user.role) && (
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
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13, lineHeight: 1.6 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  uploadRow: { marginBottom: 14 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  select: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  success: { color: 'var(--accent)', fontSize: 12, marginTop: 8 },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr 1fr', padding: '12px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', alignItems: 'center' },
  colName: { fontWeight: 600 },
  colProducer: { color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' },
  col: { color: 'var(--text-secondary)' },
  coachRow: { display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' },
  coachResult: { marginTop: 20, borderTop: '1px solid var(--border-hairline)', paddingTop: 20 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  subLabel: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' },
  emptySmall: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  opportunityRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12, marginBottom: 8 },
  opportunityTitle: { fontWeight: 600, fontSize: 13 },
  opportunitySub: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 },
  modal: { background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
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
