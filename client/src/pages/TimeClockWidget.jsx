import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const LABEL = { CLOCKED_OUT: 'Clocked out', CLOCKED_IN: 'Clocked in', ON_LUNCH: 'On lunch', ON_BREAK: 'On break' };

const PRESENCE_OPTIONS = ['AWAY', 'BREAK', 'LUNCH', 'MEETING', 'GRINDING', 'COACHING'];
const PRESENCE_LABEL = { AWAY: 'Away', BREAK: 'Break', LUNCH: 'Lunch', MEETING: 'Meeting', GRINDING: 'Grinding', COACHING: 'Coaching' };
const PRESENCE_COLOR = {
  AWAY: 'var(--text-muted)',
  BREAK: 'var(--warning)',
  LUNCH: 'var(--warning)',
  MEETING: 'var(--accent-2)',
  GRINDING: 'var(--accent)',
  COACHING: 'var(--accent-2)',
};

// A persistent status bar for Producers/Telemarketers only, per the user's
// explicit instruction that only those two roles clock in/out at all.
// Lives at the top of AppLayout (mirrors ImpersonationBar's "conditional
// full-width bar, null otherwise" shape) so it's always reachable without
// needing its own nav tab.
export default function TimeClockWidget() {
  const { user } = useAuth();
  const eligible = user?.role === 'PRODUCER' || user?.role === 'TELEMARKETER';
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState(null);
  const [assignments, setAssignments] = useState(null);
  const [agencyId, setAgencyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!eligible) return;
    load();
    if (user.role === 'TELEMARKETER') loadAssignments();
  }, [eligible, user?.role]);

  async function load() {
    try {
      const data = await api.myClockStatus();
      setState(data.state);
      setPresence(data.presenceStatus);
    } catch {
      // Non-fatal — the bar just stays quiet until the next successful poll.
    }
  }

  async function loadAssignments() {
    try {
      const data = await api.myAssignments();
      setAssignments(data.assignments);
      if (data.assignments.length === 1) setAgencyId(data.assignments[0].agency.id);
    } catch {
      // Falls through to the "pick an agency" guard below.
    }
  }

  async function act(action, fn) {
    setError('');
    setBusy(true);
    try {
      const data = await fn();
      setState(data.state);
      if (data.presenceStatus) setPresence(data.presenceStatus);
    } catch (err) {
      setError(err.data?.message || `Could not ${action}.`);
    } finally {
      setBusy(false);
    }
  }

  async function changePresence(next) {
    const prev = presence;
    setPresence(next);
    try {
      await api.setPresence(next);
    } catch (err) {
      setPresence(prev);
      setError(err.data?.message || 'Could not update status.');
    }
  }

  if (!eligible || state === null) return null;

  const needsAgencyPick = user.role === 'TELEMARKETER' && state === 'CLOCKED_OUT' && !agencyId;

  return (
    <div style={s.bar}>
      <div style={s.left}>
        <span style={s.dot(state)} />
        <span style={s.label}>{LABEL[state]}</span>

        {needsAgencyPick && assignments?.length > 1 && (
          <select style={s.select} value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
            <option value="">Select agency…</option>
            {assignments.map((a) => <option key={a.agency.id} value={a.agency.id}>{a.agency.name}</option>)}
          </select>
        )}

        {state === 'CLOCKED_OUT' && (
          <button style={s.button} disabled={busy || (user.role === 'TELEMARKETER' && !agencyId)} onClick={() => act('clock in', () => api.clockIn(agencyId))}>
            CLOCK IN
          </button>
        )}
        {state === 'CLOCKED_IN' && (
          <>
            <button style={s.buttonGhost} disabled={busy} onClick={() => act('start lunch', api.lunchStart)}>LUNCH</button>
            <button style={s.buttonGhost} disabled={busy} onClick={() => act('start break', api.breakStart)}>BREAK</button>
            <button style={s.buttonDanger} disabled={busy} onClick={() => act('clock out', api.clockOut)}>CLOCK OUT</button>
          </>
        )}
        {state === 'ON_LUNCH' && (
          <button style={s.button} disabled={busy} onClick={() => act('end lunch', api.lunchEnd)}>BACK FROM LUNCH</button>
        )}
        {state === 'ON_BREAK' && (
          <button style={s.button} disabled={busy} onClick={() => act('end break', api.breakEnd)}>BACK FROM BREAK</button>
        )}
        {error && <span style={s.error}>{error}</span>}
      </div>

      {presence && (
        <div style={s.right}>
          <span style={s.presenceDot(presence)} />
          <select style={s.presenceSelect(presence)} value={presence} onChange={(e) => changePresence(e.target.value)}>
            {PRESENCE_OPTIONS.map((p) => <option key={p} value={p}>{PRESENCE_LABEL[p]}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

const s = {
  bar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 20px',
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-hairline)', fontSize: 12,
  },
  left: { display: 'flex', alignItems: 'center', gap: 10 },
  right: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: (state) => ({
    width: 8, height: 8, borderRadius: '50%',
    background: state === 'CLOCKED_OUT' ? 'var(--text-muted)' : (state === 'ON_LUNCH' || state === 'ON_BREAK') ? 'var(--warning)' : 'var(--accent)',
  }),
  label: { color: 'var(--text-secondary)', fontWeight: 600 },
  select: { padding: '4px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  button: { padding: '4px 12px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  buttonGhost: { padding: '4px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  buttonDanger: { padding: '4px 12px', background: 'var(--danger)', color: 'var(--text-primary)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  error: { color: 'var(--danger)', fontSize: 11 },
  presenceDot: (p) => ({ width: 8, height: 8, borderRadius: '50%', background: PRESENCE_COLOR[p] || 'var(--text-muted)' }),
  presenceSelect: (p) => ({
    padding: '4px 8px', background: 'var(--bg-sunken)', border: `1px solid ${PRESENCE_COLOR[p] || 'var(--border-strong)'}`,
    borderRadius: 6, color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  }),
};
