import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { api } from '../lib/api';
import { Card, Badge, SectionHeader, EmptyState, FileDropzone } from '../ui';

function scoreTone(score) {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 80) return 'accent';
  if (score >= 60) return 'warning';
  return 'danger';
}

// Call Scoring's real job is a roster, not a flat call list: every
// producer gets their own deep profile (CallScoringProfilePage) with the
// full breakdown — the upsell feel the user asked for comes from that
// depth living one click away, not from everything crammed onto one
// page. This page stays focused on the two things that are genuinely
// agency-wide: uploading a call on a producer's behalf, and picking
// which producer to drill into.
export default function CallScoringPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const base = basePathForRole(user?.role);
  const [producers, setProducers] = useState([]);
  const [calls, setCalls] = useState([]);
  const [notEntitled, setNotEntitled] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [uploadProducerId, setUploadProducerId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadedNote, setUploadedNote] = useState('');

  useEffect(() => {
    load();
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
      setUploadedNote('Uploaded — it will appear in their profile once transcribed and scored.');
      await load();
    } catch (err) {
      setUploadError(err.data?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  // Real quick stats per producer, computed client-side from the same
  // `calls` array already fetched — no second request per row.
  const roster = producers.map((p) => {
    const theirCalls = calls.filter((c) => c.uploadedBy?.id === p.id);
    const scored = theirCalls.filter((c) => typeof c.drillScore === 'number');
    const avgDrillScore = scored.length ? Math.round(scored.reduce((sum, c) => sum + c.drillScore, 0) / scored.length) : null;
    const lastCallAt = theirCalls.length ? theirCalls.reduce((latest, c) => (new Date(c.createdAt) > new Date(latest) ? c.createdAt : latest), theirCalls[0].createdAt) : null;
    return { ...p, callCount: theirCalls.length, avgDrillScore, lastCallAt };
  }).sort((a, b) => b.callCount - a.callCount);

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
        <SectionHeader>Team ({roster.length})</SectionHeader>
        {roster.length === 0 ? (
          <EmptyState title="No producers yet" description="Invite a producer from Roster Settings to start Call Scoring." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colName}>PRODUCER</span>
              <span style={s.col}>CALLS</span>
              <span style={s.col}>AVG DRILL SCORE</span>
              <span style={s.col}>LAST CALL</span>
            </div>
            {roster.map((p) => (
              <div key={p.id} style={s.tableRow} className="ui-row-stack" onClick={() => navigate(`${base}/sales-studio/call-scoring/${p.id}`)}>
                <span style={s.colName}>{p.firstName} {p.lastName}</span>
                <span style={s.col}>{p.callCount}</span>
                <span style={s.col}>{p.avgDrillScore !== null ? <Badge tone={scoreTone(p.avgDrillScore)}>{p.avgDrillScore}</Badge> : '—'}</span>
                <span style={s.col}>{p.lastCallAt ? new Date(p.lastCallAt).toLocaleDateString() : 'never'}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

const s = {
  wrap: {},
  notEntitledBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: 20, borderRadius: 8, fontSize: 13, lineHeight: 1.6 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 28 },
  uploadRow: { marginBottom: 14 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  select: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
  success: { color: 'var(--accent)', fontSize: 12, marginTop: 8 },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '12px 16px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', alignItems: 'center' },
  colName: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
};
