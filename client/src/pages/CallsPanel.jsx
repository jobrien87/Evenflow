import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const STATUS_COLOR = {
  UPLOADED: '#888', QUEUED: '#888', TRANSCRIBING: '#ffb84d', TRANSCRIBED: '#ffb84d',
  ANALYZING: '#ffb84d', COMPLETE: '#00e5ff', FAILED: '#ff4d4d',
};

export default function CallsPanel() {
  const { user } = useAuth();
  const [calls, setCalls] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [selectedCall, setSelectedCall] = useState(null);
  const [notEntitled, setNotEntitled] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

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
          <div key={c.id} style={s.row} onClick={() => viewCall(c.id)}>
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

            {selectedCall.status === 'FAILED' && (
              <div style={s.failureBox}>
                {selectedCall.failureReason}
                <button style={s.retryButtonFull} onClick={() => { retry(selectedCall.id); setSelectedCall(null); }}>RETRY PROCESSING</button>
              </div>
            )}

            {['UPLOADED', 'QUEUED', 'TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING'].includes(selectedCall.status) && (
              <div style={s.progressBox}>Processing… this updates automatically every few seconds.</div>
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

                {selectedCall.transcript && (
                  <Section title="Full Transcript" content={<pre style={s.transcript}>{selectedCall.transcript}</pre>} />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
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
          <div style={{ color: o.handled_well ? '#00e5ff' : '#ff4d4d', fontWeight: 700, fontSize: 12 }}>
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
  notEntitledBox: { background: '#1a1610', border: '1px solid #ffb84d55', color: '#ffb84d', padding: 20, borderRadius: 8, fontSize: 13, lineHeight: 1.6 },
  reviewForm: { background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, padding: 14, marginBottom: 18 },
  reviewHint: { color: '#666', fontSize: 11, marginBottom: 10, lineHeight: 1.4 },
  reviewRow: { display: 'flex', gap: 8 },
  reviewScoreInput: { width: 90, padding: '8px 10px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 13 },
  reviewCommentInput: { flex: 1, padding: '8px 10px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 13 },
  reviewSaveButton: { padding: '8px 14px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  wrap: {},
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2 },
  uploadBox: { background: '#111', border: '1px dashed #333', borderRadius: 8, padding: 20 },
  fileInput: { color: '#fff', fontSize: 13 },
  uploading: { color: '#00e5ff', fontSize: 12, marginTop: 8 },
  error: { color: '#ff4d4d', fontSize: 12, marginTop: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8, cursor: 'pointer' },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: '#666', fontSize: 12 },
  scoreBadge: { background: '#0d1a1a', color: '#00e5ff', fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 4 },
  statusBadge: (status) => ({ fontSize: 11, color: STATUS_COLOR[status] || '#888', border: `1px solid ${STATUS_COLOR[status] || '#888'}44`, padding: '4px 8px', borderRadius: 4 }),
  retryButton: { fontSize: 10, color: '#ff4d4d', border: '1px solid #ff4d4d44', background: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: '#666', fontStyle: 'italic', fontSize: 13 },
  emptySmall: { color: '#555', fontStyle: 'italic', fontSize: 12 },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 },
  modal: { background: '#111', border: '1px solid #333', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto' },
  closeButton: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  statusLine: { color: '#aaa', fontSize: 13, marginBottom: 16 },
  failureBox: { background: '#1a0d0d', border: '1px solid #ff4d4d55', color: '#ff4d4d', padding: 14, borderRadius: 8, fontSize: 13, marginBottom: 16 },
  retryButtonFull: { display: 'block', marginTop: 10, padding: '8px 14px', background: '#ff4d4d', color: '#000', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  progressBox: { background: '#1a1610', border: '1px solid #ffb84d55', color: '#ffb84d', padding: 14, borderRadius: 8, fontSize: 13 },
  analysisBlock: { color: '#fff' },
  overallScoreRow: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 },
  overallScoreValue: { fontSize: 36, fontWeight: 800, color: '#00e5ff' },
  overallScoreLabel: { fontSize: 11, color: '#888', letterSpacing: 1 },
  overrideNote: { fontSize: 11, color: '#ffb84d', marginLeft: 'auto' },
  reviewFlag: { background: '#1a1610', border: '1px solid #ffb84d55', color: '#ffb84d', padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 16 },
  analysisSection: { marginBottom: 18 },
  analysisSectionTitle: { fontSize: 11, color: '#666', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' },
  text: { color: '#ccc', fontSize: 13, lineHeight: 1.6, margin: 0 },
  list: { margin: 0, paddingLeft: 18 },
  listItem: { color: '#ccc', fontSize: 13, marginBottom: 4 },
  objectionRow: { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #1a1a1a' },
  objectionNote: { color: '#888', fontSize: 12, marginTop: 3 },
  scoreGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  scoreCell: { background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: 6, padding: 8, textAlign: 'center' },
  scoreCellValue: { fontSize: 16, fontWeight: 700, color: '#00e5ff' },
  scoreCellLabel: { fontSize: 9, color: '#666', marginTop: 2 },
  transcript: { background: '#000', border: '1px solid #222', borderRadius: 6, padding: 12, fontSize: 12, color: '#aaa', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' },
};
