import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionHeader, Badge } from '../ui';

const POLL_MS = 15000;

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
          </div>
        ))
      )}
    </div>
  );
}

// Who's clocked in, who's on lunch, and who hasn't clocked in yet — the
// Main Stage box the Agency Owner/Manager asked for. Visible to everyone
// on the team (not gated to Owner/Manager), matching this app's existing
// "status boxes are shared" convention (e.g. the team chat unread dot).
export default function TeamClockStatusBox() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await api.teamClockStatus();
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load the team clock status.');
    }
  }

  if (!data && !error) return null;

  return (
    <Card>
      <SectionHeader>TEAM CLOCK</SectionHeader>
      {error && <div style={s.error}>{error}</div>}
      {data && (
        <div style={s.grid}>
          <Roster label="Clocked In" tone="accent" members={data.clockedIn} />
          <Roster label="On Lunch" tone="warning" members={data.onLunch} />
          <Roster label="Not Clocked In" tone="neutral" members={data.notClockedIn} />
        </div>
      )}
    </Card>
  );
}

const s = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 },
  column: { display: 'flex', flexDirection: 'column', gap: 6 },
  columnHeader: { color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1, marginBottom: 4 },
  row: {},
  empty: { color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' },
  error: { color: 'var(--danger)', fontSize: 12, marginBottom: 10 },
};
