import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Button, Card } from '../ui';
import { basePathForRole } from '../layout/navConfig';
import { useAuth } from '../lib/AuthContext';
import { GAME_COMPONENTS, GAME_LABELS } from './games';

// How often GameShell re-checks real break eligibility while a game is in
// progress. This is the server-authoritative enforcement the spec calls
// for: the client never decides "break's over" on its own, it only reacts
// to what canAccessBreakRoom() (via GET /access) actually says.
const ACCESS_POLL_MS = 5000;

// One shared wrapper around every game: starts/ends the real session,
// polls break eligibility so a game is immediately paused the moment the
// employee's break ends, and renders the shared lock / game-over / "break's
// over" screens so no individual game has to reimplement any of this.
export default function GameShell({ gameType }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = basePathForRole(user?.role);
  const [status, setStatus] = useState('starting'); // starting | locked | playing | ended | brokeOff
  const [lockMessage, setLockMessage] = useState('');
  const [result, setResult] = useState(null);
  const sessionIdRef = useRef(null);
  const liveScoreRef = useRef({ score: 0, metrics: {} });
  const endedRef = useRef(false);
  const pollRef = useRef(null);

  const Game = GAME_COMPONENTS[gameType];
  const label = GAME_LABELS[gameType] || gameType;

  const submitScore = useCallback(async (score, metrics, forced) => {
    if (endedRef.current || !sessionIdRef.current) return;
    endedRef.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
    try {
      const res = await api.endBreakRoomSession(sessionIdRef.current, { score: Math.max(0, Math.round(score || 0)), metrics: metrics || {} });
      setResult(res);
    } catch (err) {
      setResult({ error: err.data?.message || 'Could not save your score.', rejected: err.status === 422 });
    }
    setStatus(forced ? 'brokeOff' : 'ended');
  }, []);

  const reportLive = useCallback((score, metrics) => {
    liveScoreRef.current = { score, metrics: metrics || {} };
  }, []);

  const onGameOver = useCallback((score, metrics) => {
    submitScore(score, metrics, false);
  }, [submitScore]);

  const startSession = useCallback(async (cancelledRef) => {
    endedRef.current = false;
    sessionIdRef.current = null;
    setResult(null);
    liveScoreRef.current = { score: 0, metrics: {} };
    setStatus('starting');
    try {
      const access = await api.breakRoomAccess();
      if (cancelledRef?.current) return;
      if (!access.allowed) {
        setLockMessage(access.message || "You're not on break right now.");
        setStatus('locked');
        return;
      }
      const started = await api.startBreakRoomSession(gameType);
      if (cancelledRef?.current) return;
      sessionIdRef.current = started.sessionId;
      setStatus('playing');

      pollRef.current = setInterval(async () => {
        try {
          const check = await api.breakRoomAccess();
          if (!check.allowed) {
            const { score, metrics } = liveScoreRef.current;
            submitScore(score, metrics, true);
          }
        } catch {
          // A transient network hiccup shouldn't yank the game away —
          // only an authoritative "not allowed" response ends it early.
        }
      }, ACCESS_POLL_MS);
    } catch (err) {
      if (cancelledRef?.current) return;
      setLockMessage(err.data?.message || 'This game is unavailable right now.');
      setStatus('locked');
    }
  }, [gameType, submitScore]);

  useEffect(() => {
    const cancelledRef = { current: false };
    startSession(cancelledRef);
    return () => {
      cancelledRef.current = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [startSession]);

  function playAgain() {
    if (pollRef.current) clearInterval(pollRef.current);
    startSession();
  }

  if (!Game) {
    return (
      <Card style={s.center}>
        <div style={s.title}>{label}</div>
        <div style={s.muted}>This game isn't ready yet. Check back soon.</div>
        <Button variant="secondary" style={{ marginTop: 16 }} onClick={() => navigate(`${base}/break-room`)}>BACK TO BREAK ROOM</Button>
      </Card>
    );
  }

  if (status === 'starting') {
    return <Card style={s.center}><div style={s.muted}>Loading {label}…</div></Card>;
  }

  if (status === 'locked') {
    return (
      <Card style={s.center}>
        <div style={s.lockTitle}>BREAK ROOM</div>
        <div style={s.muted}>{lockMessage}</div>
        <Button variant="primary" style={{ marginTop: 16 }} onClick={() => navigate(`${base}/break-room`)}>BACK TO BREAK ROOM</Button>
      </Card>
    );
  }

  if (status === 'brokeOff') {
    return (
      <Card style={s.center}>
        <div style={s.lockTitle}>BREAK'S OVER</div>
        <div style={s.muted}>Time to make some money.</div>
        {result && !result.error && (
          <div style={s.scoreLine}>Final score saved: {result.session?.score ?? 0}</div>
        )}
        <Button variant="primary" style={{ marginTop: 16 }} onClick={() => navigate(base)}>RETURN TO EVENFLOW</Button>
      </Card>
    );
  }

  if (status === 'ended') {
    return (
      <Card style={s.center}>
        <div style={s.title}>GAME OVER</div>
        {result?.error ? (
          <div style={s.muted}>{result.error}</div>
        ) : (
          <>
            <div style={s.scoreBig}>{result?.session?.score ?? 0}</div>
            {result?.newPersonalBest && <div style={s.pbRibbon}>NEW PERSONAL BEST</div>}
            {result?.flagged && <div style={s.flagNote}>This run is under review and won't count on leaderboards yet.</div>}
            {result?.achievementsUnlocked?.length > 0 && (
              <div style={s.achievements}>
                {result.achievementsUnlocked.map((a) => (
                  <div key={a.key} style={s.achievement}>🏆 {a.label}</div>
                ))}
              </div>
            )}
          </>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button variant="primary" onClick={playAgain}>PLAY AGAIN</Button>
          <Button variant="secondary" onClick={() => navigate(`${base}/break-room`)}>BACK TO BREAK ROOM</Button>
        </div>
      </Card>
    );
  }

  return <Game onScoreUpdate={reportLive} onGameOver={onGameOver} />;
}

const s = {
  center: { textAlign: 'center', padding: 'var(--space-8) var(--space-6)', maxWidth: 480, margin: '40px auto' },
  title: { fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: 1, marginBottom: 8 },
  lockTitle: {
    fontSize: 24, fontWeight: 900, letterSpacing: 2, marginBottom: 10,
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  scoreLine: { color: 'var(--text-secondary)', fontSize: 13, marginTop: 10 },
  scoreBig: { fontSize: 48, fontWeight: 900, color: 'var(--text-primary)', margin: '12px 0' },
  pbRibbon: {
    display: 'inline-block', padding: '4px 14px', borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: 1,
    background: 'var(--accent-gradient)', color: 'var(--accent-on)', marginBottom: 8,
  },
  flagNote: { color: 'var(--warning)', fontSize: 12, marginTop: 8 },
  achievements: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 },
  achievement: { color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 },
};
