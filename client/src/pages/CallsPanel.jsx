import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card, StatTile, SectionHeader, DateRangeFilter } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import CoachingBreakdownResult from './CoachingBreakdownResult';
import CoachingVideoTheater from './CoachingVideoTheater';

export const STATUS_COLOR = {
  UPLOADED: 'var(--text-secondary)', QUEUED: 'var(--text-secondary)', TRANSCRIBING: 'var(--warning)', TRANSCRIBED: 'var(--warning)',
  ANALYZING: 'var(--warning)', COMPLETE: 'var(--accent)', FAILED: 'var(--danger)',
};

const COACHING_PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: '30d', label: 'Last 30 days', from: () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
];

export default function CallsPanel() {
  const { user } = useAuth();
  const [notEntitled, setNotEntitled] = useState(false);

  // This page no longer owns a call list of its own — raw call upload/
  // review now lives entirely on Call Scoring (Owner/Manager-driven) and
  // each producer's own Call Scoring profile. This probe just confirms
  // Sales Studio is actually unlocked for this agency (requireSalesStudioAccess
  // gates the whole /calls router server-side) so an un-entitled agency
  // still gets a clear banner instead of a page that silently renders empty.
  useEffect(() => {
    api.coachingVideos().catch((err) => {
      if (err.data?.error === 'MODULE_NOT_ENTITLED') setNotEntitled(true);
    });
  }, []);

  // Moved here from the retired standalone Training tab — the real same
  // TrainingAssignment-backed numbers (Assigned/Completed/In Progress/
  // Lesson Completion), just relocated to the top of TP Sales Process.
  // Producer-only: course assignment is a per-producer concept with no
  // equivalent on an Owner/Manager's own account.
  const [courseAssignments, setCourseAssignments] = useState([]);
  useEffect(() => {
    if (user?.role !== 'PRODUCER') return;
    api.myTrainingAssignments().then((data) => setCourseAssignments(data.assignments)).catch(() => {});
  }, [user?.role]);

  const [coachPeriod, setCoachPeriod] = useState('month');
  const [coachCustomFrom, setCoachCustomFrom] = useState('');
  const [coachCustomTo, setCoachCustomTo] = useState('');
  const [coachResult, setCoachResult] = useState(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachError, setCoachError] = useState('');

  async function generateMyCoaching() {
    const range = resolveDateRange(coachPeriod, COACHING_PERIODS, coachCustomFrom, coachCustomTo);
    if (!range) return; // custom selected, dates not both picked yet
    setCoachBusy(true);
    setCoachError('');
    try {
      const data = await api.coachingBreakdown(`?from=${range.from}&to=${range.to}`);
      setCoachResult(data);
    } catch (err) {
      setCoachError(err.data?.message || 'Could not generate your coaching breakdown.');
    } finally {
      setCoachBusy(false);
    }
  }

  // Producers get their own self-service coaching breakdown loaded
  // automatically (Agency Owner/Manager get the equivalent Coaching Box
  // on Call Scoring instead, scoped to whichever producer they pick).
  useEffect(() => {
    if (user?.role === 'PRODUCER') generateMyCoaching();
  }, [user?.role, coachPeriod, coachCustomFrom, coachCustomTo]);

  if (notEntitled) {
    return (
      <div style={s.notEntitledBox}>
        Sales Coaching isn't included on your current plan. Check the Billing tab, or ask your platform contact to enable it.
      </div>
    );
  }

  // Same "At a Glance" math the old standalone Training tab used, just
  // relocated here.
  const caTotal = courseAssignments.length;
  const caCompleted = courseAssignments.filter((a) => a.status === 'COMPLETED').length;
  const caInProgress = courseAssignments.filter((a) => a.status === 'IN_PROGRESS').length;
  const caTotalLessons = courseAssignments.reduce((sum, a) => sum + (a.progress?.total || 0), 0);
  const caCompletedLessons = courseAssignments.reduce((sum, a) => sum + (a.progress?.completed || 0), 0);
  const caCompletionRate = caTotalLessons > 0 ? Math.round((caCompletedLessons / caTotalLessons) * 100) : null;

  return (
    <div style={s.wrap}>
      {user.role === 'PRODUCER' && caTotal > 0 && (
        <section style={s.section}>
          <SectionHeader>Sales Courses</SectionHeader>
          <div style={s.statsRow}>
            <StatTile label="Assigned" value={caTotal} />
            <StatTile
              label="Completed"
              value={caCompleted}
              sub={`${Math.round((caCompleted / caTotal) * 100)}% done`}
            />
            <StatTile label="In Progress" value={caInProgress} />
            <StatTile
              label="Lesson Completion"
              value={caCompletionRate !== null ? `${caCompletionRate}%` : '—'}
              sub={caCompletionRate === null ? 'no lessons assigned yet' : `${caCompletedLessons}/${caTotalLessons} lessons`}
            />
          </div>
        </section>
      )}

      <CoachingVideoTheater />

      {user.role === 'PRODUCER' && (
        <section style={s.section}>
          <div style={s.headerRow}>
            <SectionHeader>My Coaching Breakdown</SectionHeader>
            <DateRangeFilter
              presets={COACHING_PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
              periodKey={coachPeriod}
              onSelectPreset={setCoachPeriod}
              customFrom={coachCustomFrom}
              customTo={coachCustomTo}
              onCustomFromChange={setCoachCustomFrom}
              onCustomToChange={setCoachCustomTo}
            />
          </div>
          <Card>
            {coachError && <div style={s.error}>{coachError}</div>}
            {coachBusy && !coachResult && <div style={s.thinking}>Loading your breakdown…</div>}
            {coachResult && (
              <CoachingBreakdownResult result={coachResult} emptyDescription="You have no analyzed calls in this period yet." />
            )}
          </Card>
        </section>
      )}
    </div>
  );
}

export function TranscriptEntry({ onSubmit }) {
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

// Per-call Bunny Stream video — the video itself lives on Bunny.net
// (uploaded there directly, outside this app); this just attaches/plays
// its GUID, mirroring TranscriptEntry's entry-form shape above.
export function CallVideoSection({ call, onAttach, onRemove }) {
  const [videoId, setVideoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!videoId.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onAttach(videoId.trim());
      setVideoId('');
    } catch (err) {
      setError(err.data?.message || 'Failed to attach video.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await onRemove();
    } catch (err) {
      setError(err.data?.message || 'Failed to remove video.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Call Video"
      content={
        call.bunnyEmbedUrl ? (
          <div>
            <iframe
              style={s.videoEmbed}
              src={call.bunnyEmbedUrl}
              loading="lazy"
              allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;"
              allowFullScreen
              title="Call video"
            />
            {error && <div style={s.error}>{error}</div>}
            <button style={s.removeVideoButton} disabled={busy} onClick={remove}>
              {busy ? 'Removing…' : 'REMOVE VIDEO'}
            </button>
          </div>
        ) : (
          <div>
            <div style={s.transcriptHint}>
              Paste this call's Bunny Stream video id (uploaded directly in your Bunny.net dashboard) to play it here.
            </div>
            <div style={s.videoIdRow}>
              <input
                style={s.videoIdInput}
                placeholder="Bunny video id"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
              />
              <button style={s.submitButton} disabled={busy || !videoId.trim()} onClick={submit}>
                {busy ? 'Attaching…' : 'ATTACH VIDEO'}
              </button>
            </div>
            {error && <div style={s.error}>{error}</div>}
          </div>
        )
      }
    />
  );
}

export function Section({ title, content }) {
  return (
    <div style={s.analysisSection}>
      <div style={s.analysisSectionTitle}>{title}</div>
      {content}
    </div>
  );
}

export function List({ items }) {
  if (!items || items.length === 0) return <div style={s.emptySmall}>None noted.</div>;
  return (
    <ul style={s.list}>
      {items.map((item, i) => <li key={i} style={s.listItem}>{item}</li>)}
    </ul>
  );
}

export function ObjectionsList({ items }) {
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

export function ScoreGrid({ scores }) {
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

export function ManagerReviewForm({ analysis, onSubmit }) {
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
  thinking: { color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' },
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13, lineHeight: 1.6 },
  reviewForm: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 18 },
  reviewHint: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 10, lineHeight: 1.4 },
  reviewRow: { display: 'flex', gap: 8 },
  reviewScoreInput: { width: 90, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  reviewCommentInput: { flex: 1, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  reviewSaveButton: { padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  wrap: {},
  section: { marginBottom: 28 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  emptySmall: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  transcriptHint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 8, lineHeight: 1.5 },
  transcriptInput: { width: '100%', minHeight: 160, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 },
  submitButton: { padding: '10px 16px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  videoEmbed: { width: '100%', aspectRatio: '16 / 9', border: 'none', borderRadius: 8, marginBottom: 8 },
  videoIdRow: { display: 'flex', gap: 8 },
  videoIdInput: { flex: 1, padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box' },
  removeVideoButton: { padding: '8px 14px', background: 'transparent', color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  analysisSection: { marginBottom: 18 },
  analysisSectionTitle: { fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, textTransform: 'uppercase' },
  list: { margin: 0, paddingLeft: 18 },
  listItem: { color: 'var(--text-secondary)', fontSize: 13, marginBottom: 4 },
  objectionRow: { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border-hairline)' },
  objectionNote: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 3 },
  scoreGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  scoreCell: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6, padding: 8, textAlign: 'center' },
  scoreCellValue: { fontSize: 16, fontWeight: 700, color: 'var(--accent)' },
  scoreCellLabel: { fontSize: 9, color: 'var(--text-muted)', marginTop: 2 },
};
