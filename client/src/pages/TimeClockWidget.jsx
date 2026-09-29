import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const LABEL = { CLOCKED_OUT: 'Clocked out', CLOCKED_IN: 'Clocked in', ON_LUNCH: 'On lunch' };

// A persistent status bar for Producers/Telemarketers only, per the user's
// explicit instruction that only those two roles clock in/out at all.
// Lives at the top of AppLayout (mirrors ImpersonationBar's "conditional
// full-width bar, null otherwise" shape) so it's always reachable without
// needing its own nav tab.
export default function TimeClockWidget() {
  const { user } = useAuth();
  const eligible = user?.role === 'PRODUCER' || user?.role === 'TELEMARKETER';
  const [state, setState] = useState(null);
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
    } catch (err) {
      setError(err.data?.message || `Could not ${action}.`);
    } finally {
      setBusy(false);
    }
  }

  if (!eligible || state === null) return null;

  const needsAgencyPick = user.role === 'TELEMARKETER' && state === 'CLOCKED_OUT' && !agencyId;

  return (
    <div style={s.bar}>
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
          <button style={s.buttonDanger} disabled={busy} onClick={() => act('clock out', api.clockOut)}>CLOCK OUT</button>
        </>
      )}
      {state === 'ON_LUNCH' && (
        <button style={s.button} disabled={busy} onClick={() => act('end lunch', api.lunchEnd)}>BACK FROM LUNCH</button>
      )}
      {error && <span style={s.error}>{error}</span>}
    </div>
  );
}

const s = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 20px',
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-hairline)', fontSize: 12,
  },
  dot: (state) => ({
    width: 8, height: 8, borderRadius: '50%',
    background: state === 'CLOCKED_OUT' ? 'var(--text-muted)' : state === 'ON_LUNCH' ? 'var(--warning)' : 'var(--accent)',
  }),
  label: { color: 'var(--text-secondary)', fontWeight: 600 },
  select: { padding: '4px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11 },
  button: { padding: '4px 12px', background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  buttonGhost: { padding: '4px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  buttonDanger: { padding: '4px 12px', background: 'var(--danger)', color: 'var(--text-primary)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  error: { color: 'var(--danger)', fontSize: 11 },
};
