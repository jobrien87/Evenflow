import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const STATUS_COLOR = {
  UPLOADED: 'var(--text-secondary)', QUEUED: 'var(--text-secondary)', TRANSCRIBING: 'var(--warning)', TRANSCRIBED: 'var(--warning)',
  ANALYZING: 'var(--warning)', COMPLETE: 'var(--accent)', FAILED: 'var(--danger)',
};

export default function CallsPanel() {
  const { user } = useAuth();
  const [calls, setCalls] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [selectedCall, setSelectedCall] = useState(null);
  const [notEntitled, setNotEntitled] = useState(false);
  const fileInputRef = useRef(null);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  // Destination side of notification deep-linking — a call notification
  // (e.g. analysis complete) opens straight into that call's detail view.
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || calls.length === 0) return;
    if (!calls.some((c) => c.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`call-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    viewCall(highlightId);
  }, [highlightId, calls]);

  async function load() {
    try {
      const data = await api.calls();
      setCalls(data.calls);
      setNotEntitled(false);
    } catch (err) {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') {
        setNotEntitled(true);
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

  async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      await api.uploadCall(file);
      await load();
    } catch (err) {
      setUploadError(err.data?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function viewCall(id) {
    const data = await api.callDetail(id);
    setSelectedCall(data.call);
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

  return (
    <div style={s.wrap}>
      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>UPLOAD CALL</h3>
        </div>
        <div style={s.uploadBox}>
          <input ref={fileInputRef} type="file" accept="audio/*,video/mp4" onChange={handleFileSelect} disabled={uploading} style={s.fileInput} />
          {uploading && <div style={s.uploading}>Uploading…</div>}
          {uploadError && <div style={s.error}>{uploadError}</div>}
        </div>
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>CALL LIBRARY ({calls.length})</h3>
        {calls.length === 0 && (
          <div style={s.empty}>No calls yet. Upload your first recorded sales call to receive transcription and coaching.</div>
        )}
        {calls.map((c) => (
          <div
            key={c.id}
            id={`call-${c.id}`}
            style={c.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row}
            className="ui-row-stack"
            onClick={() => viewCall(c.id)}
          >
            <div>
              <div style={s.rowTitle}>{c.filename}</div>
              <div style={s.rowSub}>{c.uploadedBy.firstName} {c.uploadedBy.lastName} · {new Date(c.createdAt).toLocaleString()}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {c.analysis && <div style={s.scoreBadge}>{c.analysis.overallScore}</div>}
              <div style={s.statusBadge(c.status)}>{c.status}</div>
              {c.status === 'FAILED' && (
                <button style={s.retryButton} onClick={(e) => { e.stopPropagation(); retry(c.id); }}>RETRY</button>
              )}
            </div>
          </div>
        ))}
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
            </div>

            <audio style={s.audioPlayer} controls crossOrigin="use-credentials" src={api.callAudioUrl(selectedCall.id)} />

            {selectedCall.status === 'FAILED' && (
              <div style={s.failureBox}>
                {selectedCall.failureReason}
                {!selectedCall.transcript && (
                  <div style={s.failureHint}>You can also enter the transcript below by hand — analysis will run on it once submitted.</div>
                )}
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
              <div style={s.analysisBlock}>
                <div style={s.overallScoreRow}>
                  <div style={s.overallScoreValue}>{selectedCall.analysis.overallScore}</div>
                  <div style={s.overallScoreLabel}>OVERALL SCORE</div>
                  {selectedCall.analysis.managerOverrideScore != null && (
                    <div style={s.overrideNote}>Manager adjusted: {selectedCall.analysis.managerOverrideScore}</div>
                  )}
                </div>

                {selectedCall.analysis.reviewRecommended && (
                  <div style={s.reviewFlag}>REVIEW RECOMMENDED: {selectedCall.analysis.reviewReason}</div>
                )}

                <Section title="Summary" content={<p style={s.text}>{selectedCall.analysis.summary}</p>} />
                <Section title="Dimension Scores" content={<ScoreGrid scores={selectedCall.analysis.dimensionScores} />} />
                <Section title="Strengths" content={<List items={selectedCall.analysis.strengths} />} />
                <Section title="Coaching Opportunities" content={<List items={selectedCall.analysis.coachingOpportunities} />} />

                {['AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'].includes(user.role) && (
                  <ManagerReviewForm analysis={selectedCall.analysis} onSubmit={submitReview} />
                )}

                <Section title="Objections" content={<ObjectionsList items={selectedCall.analysis.objections} />} />
                <Section title="Cross-Sell Opportunities" content={<List items={selectedCall.analysis.crossSellOpportunities} />} />
                <Section title="Next Steps" content={<List items={selectedCall.analysis.nextSteps} />} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptEntry({ onSubmit }) {
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!transcript.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(transcript.trim());
    } catch (err) {
      setError(err.data?.message || 'Failed to save transcript.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Transcript"
      content={
        <div>
          <div style={s.transcriptHint}>
            No automatic transcription is configured for this environment — paste or type the real transcript below to run real analysis on it.
          </div>
          <textarea
            style={s.transcriptInput}
            placeholder="Paste the call transcript here…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
          {error && <div style={s.error}>{error}</div>}
          <button style={s.submitButton} disabled={busy || !transcript.trim()} onClick={submit}>
            {busy ? 'Submitting…' : 'SUBMIT TRANSCRIPT & ANALYZE'}
          </button>
        </div>
      }
    />
  );
}

function Section({ title, content }) {
  return (
    <div style={s.analysisSection}>
      <div style={s.analysisSectionTitle}>{title}</div>
      {content}
    </div>
  );
}

function List({ items }) {
  if (!items || items.length === 0) return <div style={s.emptySmall}>None noted.</div>;
  return (
    <ul style={s.list}>
      {items.map((item, i) => <li key={i} style={s.listItem}>{item}</li>)}
    </ul>
  );
}

function ObjectionsList({ items }) {
  if (!items || items.length === 0) return <div style={s.emptySmall}>None noted.</div>;
  return (
    <div>
      {items.map((o, i) => (
        <div key={i} style={s.objectionRow}>
          <div style={{ color: o.handled_well ? 'var(--accent)' : 'var(--danger)', fontWeight: 700, fontSize: 12 }}>
            {o.objection} {o.handled_well ? '(handled well)' : '(needs work)'}
          </div>
          <div style={s.objectionNote}>{o.note}</div>
        </div>
      ))}
    </div>
  );
}

function ScoreGrid({ scores }) {
  return (
    <div style={s.scoreGrid}>
      {Object.entries(scores || {}).map(([dim, score]) => (
        <div key={dim} style={s.scoreCell}>
          <div style={s.scoreCellValue}>{score}</div>
          <div style={s.scoreCellLabel}>{dim}</div>
        </div>
      ))}
    </div>
  );
}

function ManagerReviewForm({ analysis, onSubmit }) {
  const [score, setScore] = useState(analysis.managerOverrideScore != null ? String(analysis.managerOverrideScore) : '');
  const [comment, setComment] = useState(analysis.managerComment || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onSubmit(score, comment);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.reviewForm}>
      <div style={s.analysisSectionTitle}>Manager Review</div>
      <div style={s.reviewHint}>
        The AI score above is preserved as-is. Your adjustment is stored separately, not overwritten.
      </div>
      <div style={s.reviewRow}>
        <input
          style={s.reviewScoreInput}
          type="number"
          min="0"
          max="100"
          placeholder="Adjusted score"
          value={score}
          onChange={(e) => setScore(e.target.value)}
        />
        <input
          style={s.reviewCommentInput}
          placeholder="Comment for the producer"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <button style={s.reviewSaveButton} disabled={busy} onClick={submit}>
          {saved ? 'SAVED' : 'SAVE'}
        </button>
      </div>
    </div>
  );
}

const s = {
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13, lineHeight: 1.6 },
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)', borderRadius: 'var(--radius-md)' },
  reviewForm: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 18 },
  reviewHint: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 10, lineHeight: 1.4 },
  reviewRow: { display: 'flex', gap: 8 },
  reviewScoreInput: { width: 90, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  reviewCommentInput: { flex: 1, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  reviewSaveButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  wrap: {},
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  uploadBox: { background: 'var(--bg-elevated)', border: '1px dashed var(--border-strong)', borderRadius: 8, padding: 20 },
  fileInput: { color: 'var(--text-primary)', fontSize: 13 },
  uploading: { color: 'var(--accent)', fontSize: 12, marginTop: 8 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8, cursor: 'pointer' },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  scoreBadge: { background: 'var(--accent-gradient-soft)', color: 'var(--accent)', fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 4 },
  statusBadge: (status) => ({ fontSize: 11, color: STATUS_COLOR[status] || 'var(--text-secondary)', border: `1px solid ${STATUS_COLOR[status] || 'var(--text-secondary)'}44`, padding: '4px 8px', borderRadius: 4 }),
  retryButton: { fontSize: 10, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
  emptySmall: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 },
  modal: { background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  statusLine: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 },
  audioPlayer: { width: '100%', marginBottom: 16 },
  failureBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 14, borderRadius: 8, fontSize: 13, marginBottom: 16 },
  failureHint: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 8, lineHeight: 1.5 },
  transcriptHint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 8, lineHeight: 1.5 },
  transcriptInput: { width: '100%', minHeight: 160, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 },
  submitButton: { padding: '10px 16px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  retryButtonFull: { display: 'block', marginTop: 10, padding: '8px 14px', background: 'var(--danger)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  progressBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 14, borderRadius: 8, fontSize: 13 },
  analysisBlock: { color: 'var(--text-primary)' },
  overallScoreRow: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 },
  overallScoreValue: { fontSize: 36, fontWeight: 800, color: 'var(--accent)' },
  overallScoreLabel: { fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 1 },
  overrideNote: { fontSize: 11, color: 'var(--warning)', marginLeft: 'auto' },
  reviewFlag: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 16 },
  analysisSection: { marginBottom: 18 },
  analysisSectionTitle: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' },
  text: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 },
  list: { margin: 0, paddingLeft: 18 },
  listItem: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 4 },
  objectionRow: { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border-hairline)' },
  objectionNote: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 3 },
  scoreGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  scoreCell: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, padding: 8, textAlign: 'center' },
  scoreCellValue: { fontSize: 16, fontWeight: 700, color: 'var(--accent)' },
  scoreCellLabel: { fontSize: 9, color: 'var(--text-muted)', marginTop: 2 },
  transcript: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, padding: 12, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' },
};
