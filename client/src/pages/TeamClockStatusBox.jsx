import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Badge } from '../ui';

const POLL_MS = 15000;

// Column order and tone per PresenceStatus — GRINDING first since that's
// the "everyone's working" default state most of the day.
const COLUMNS = [
  { key: 'GRINDING', label: 'Grinding', tone: 'accent' },
  { key: 'BREAK', label: 'On Break', tone: 'warning' },
  { key: 'LUNCH', label: 'On Lunch', tone: 'warning' },
  { key: 'MEETING', label: 'In Meeting', tone: 'info' },
  { key: 'COACHING', label: 'Coaching', tone: 'info' },
  { key: 'AWAY', label: 'Away', tone: 'neutral' },
];

function since(ts) {
  if (!ts) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function Roster({ label, tone, members }) {
  return (
    <div style={s.column}>
      <div style={s.columnHeader}>{label} ({members.length})</div>
      {members.length === 0 ? (
        <div style={s.empty}>—</div>
      ) : (
        members.map((m) => (
          <div key={m.id} style={s.row}>
            <Badge tone={tone}>{m.firstName} {m.lastName}</Badge>
            {m.since && <span style={s.since}>{since(m.since)}</span>}
          </div>
        ))
      )}
    </div>
  );
}

// Who's grinding, on break/lunch, in a meeting/coaching, or away — the Main
// Stage box the Agency Owner/Manager asked for, driven by each producer's
// own live presence bubble. Visible to everyone on the team (not gated to
// Owner/Manager), matching this app's existing "status boxes are shared"
// convention (e.g. the team chat unread dot).
export default function TeamClockStatusBox() {
  const [team, setTeam] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await api.teamClockStatus();
      setTeam(res.team);
    } catch (err) {
      setError(err.data?.message || 'Could not load the team clock status.');
    }
  }

  if (!team && !error) return null;

  const grouped = team ? COLUMNS.map((c) => ({ ...c, members: team.filter((m) => m.presenceStatus === c.key) })) : [];

  return (
    <Card>
      <SectionHeader>TEAM STATUS</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {team && (
        <div style={s.grid}>
          {grouped.map((c) => <Roster key={c.key} label={c.label} tone={c.tone} members={c.members} />)}
        </div>
      )}
    </Card>
  );
}

const s = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 },
  column: { display: 'flex', flexDirection: 'column', gap: 6 },
  columnHeader: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, marginBottom: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  since: { color: 'var(--text-muted)', fontSize: 10 },
  empty: { color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
};
