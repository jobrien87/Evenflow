import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Badge, Button, EmptyState } from '../ui';
import { GAME_LABELS } from '../breakRoom/games';

// Super Admin (Platform Owner) moderation surface for the Break Room
// Arcade — flag/remove fraudulent-looking sessions, reset a leaderboard,
// and toggle the cross-agency global leaderboard. Regular Agency
// Owners/Managers get their own, narrower per-agency settings tab on
// Roster Settings instead (enable/disable games, lunch access, etc.) —
// this page is the platform-wide moderation layer only.
export default function BreakRoomAdminPanel() {
  const [sessions, setSessions] = useState([]);
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [platformSettings, setPlatformSettings] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [resetForm, setResetForm] = useState({ gameType: 'CONGO_LINE', agencyId: '', officeId: '' });
  const [resetStatus, setResetStatus] = useState('');

  useEffect(() => {
    load();
  }, [flaggedOnly]);

  async function load() {
    setError('');
    try {
      const [sessionData, settingsData] = await Promise.all([
        api.breakRoomAdminSessions(flaggedOnly ? '?flagged=true' : ''),
        api.breakRoomPlatformSettings(),
      ]);
      setSessions(sessionData.sessions);
      setPlatformSettings(settingsData.settings);
    } catch (err) {
      setError(err.data?.message || 'Could not load Break Room admin data.');
    }
  }

  async function removeSession(id) {
    setBusyId(id);
    try {
      await api.breakRoomAdminRemoveSession(id, 'Removed by Platform Owner');
      await load();
    } catch (err) {
      setError(err.data?.message || 'Could not remove this session.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleGlobalLeaderboard() {
    try {
      const data = await api.updateBreakRoomPlatformSettings({ globalLeaderboardEnabled: !platformSettings.globalLeaderboardEnabled });
      setPlatformSettings(data.settings);
    } catch (err) {
      setError(err.data?.message || 'Could not update the global leaderboard flag.');
    }
  }

  async function resetLeaderboard(e) {
    e.preventDefault();
    setResetStatus('');
    try {
      const payload = { gameType: resetForm.gameType };
      if (resetForm.agencyId.trim()) payload.agencyId = resetForm.agencyId.trim();
      if (resetForm.officeId.trim()) payload.officeId = resetForm.officeId.trim();
      const data = await api.breakRoomAdminResetLeaderboard(payload);
      setResetStatus(`Reset: ${data.sessionsExcluded} sessions excluded, ${data.highScoresRemoved} high scores removed.`);
      await load();
    } catch (err) {
      setResetStatus(err.data?.message || 'Could not reset this leaderboard.');
    }
  }

  if (error) return <EmptyState title="Couldn't load Break Room admin" description={error} />;

  return (
    <div>
      <SectionHeader>Break Room Admin</SectionHeader>

      <Card style={s.card}>
        <div style={s.cardTitle}>GLOBAL LEADERBOARD</div>
        <div style={s.rowSub}>Cross-agency leaderboard, visible to every employee when on.</div>
        {platformSettings && (
          <label style={s.checkboxRow}>
            <input type="checkbox" checked={platformSettings.globalLeaderboardEnabled} onChange={toggleGlobalLeaderboard} />
            Enable the global (cross-agency) leaderboard
          </label>
        )}
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitle}>RESET A LEADERBOARD</div>
        <form onSubmit={resetLeaderboard} style={s.form}>
          <select style={s.input} value={resetForm.gameType} onChange={(e) => setResetForm({ ...resetForm, gameType: e.target.value })}>
            {Object.keys(GAME_LABELS).map((g) => <option key={g} value={g}>{GAME_LABELS[g]}</option>)}
          </select>
          <input style={s.input} placeholder="Agency ID (optional — leave blank for all)" value={resetForm.agencyId} onChange={(e) => setResetForm({ ...resetForm, agencyId: e.target.value })} />
          <input style={s.input} placeholder="Office ID (optional)" value={resetForm.officeId} onChange={(e) => setResetForm({ ...resetForm, officeId: e.target.value })} />
          <Button type="submit" size="sm" variant="danger">RESET</Button>
        </form>
        {resetStatus && <div style={s.status}>{resetStatus}</div>}
      </Card>

      <Card style={s.card}>
        <div style={s.cardTitle}>SESSIONS</div>
        <label style={s.checkboxRow}>
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
          Flagged only
        </label>
        {sessions.map((sess) => (
          <div key={sess.id} style={s.sessionRow}>
            <div>
              <div style={s.rowTitle}>{sess.user.firstName} {sess.user.lastName} — {GAME_LABELS[sess.gameType]}</div>
              <div style={s.rowSub}>
                {sess.agency.name} · score {sess.score} · {sess.status}
                {sess.excludedFromLeaderboard && <Badge tone="warning" style={{ marginLeft: 8 }}>{sess.flagReason || 'FLAGGED'}</Badge>}
              </div>
            </div>
            {!sess.excludedFromLeaderboard && (
              <button style={s.deactivateButton} disabled={busyId === sess.id} onClick={() => removeSession(sess.id)}>REMOVE</button>
            )}
          </div>
        ))}
        {sessions.length === 0 && <div style={s.empty}>No {flaggedOnly ? 'flagged ' : ''}sessions.</div>}
      </Card>
    </div>
  );
}

const s = {
  card: { marginBottom: 16, padding: 'var(--space-4)' },
  cardTitle: { fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', padding: '6px 0', cursor: 'pointer' },
  form: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  input: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  status: { color: 'var(--accent)', fontSize: 12, marginTop: 8 },
  sessionRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-hairline)', gap: 10 },
  rowTitle: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' },
  deactivateButton: { fontSize: 11, color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', background: 'none', padding: '4px 10px', borderRadius: 4, cursor: 'pointer' },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13 },
};
