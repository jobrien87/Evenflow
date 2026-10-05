import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from '../layout/navConfig';
import { Card, Badge, Button, SectionHeader, EmptyState, Icon, Modal } from '../ui';
import { GAME_LABELS, GAME_BLURBS } from '../breakRoom/games';

// How often the landing page re-checks break eligibility — this is what
// makes the lock screen lift the instant the employee actually clocks
// into break elsewhere (the TimeClockWidget bar), without a manual refresh.
const ACCESS_POLL_MS = 10000;

const PERIODS = [
  { key: 'today', label: 'TODAY' },
  { key: 'week', label: 'WEEK' },
  { key: 'month', label: 'MONTH' },
  { key: 'all', label: 'ALL TIME' },
];

export default function BreakRoomPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const base = basePathForRole(user?.role);
  const [access, setAccess] = useState(null);
  const [home, setHome] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [startingBreak, setStartingBreak] = useState(false);
  const [jokeOpen, setJokeOpen] = useState(false);
  const [leaderboardGame, setLeaderboardGame] = useState(null);
  const [achievementsOpen, setAchievementsOpen] = useState(false);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), ACCESS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function load(silent) {
    if (!silent) setError('');
    try {
      const [accessData, homeData] = await Promise.all([api.breakRoomAccess(), api.breakRoomHome()]);
      setAccess(accessData);
      setHome(homeData);
    } catch (err) {
      if (!silent) setError(err.data?.message || 'Could not load the Break Room. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function startBreak() {
    setStartingBreak(true);
    try {
      await api.breakStart();
      await load();
    } catch (err) {
      setError(err.data?.message || 'Could not start your break.');
    } finally {
      setStartingBreak(false);
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  const unlocked = !!access?.allowed;
  const games = home?.games || [];
  const champion = home?.todaysChampion;

  return (
    <div style={s.wrap}>
      <SectionHeader>BREAK ROOM ARCADE</SectionHeader>

      {error && <div style={s.errorBox}>{error}<button style={s.retryButton} onClick={() => load()}>RETRY</button></div>}

      {champion && (
        <Card style={s.championCard}>
          <div style={s.championLabel}>🏆 TODAY'S CHAMPION</div>
          <div style={s.championLine}>
            {champion.firstName} {champion.lastName} — {champion.score.toLocaleString()} in {GAME_LABELS[champion.gameType]}
          </div>
        </Card>
      )}

      <div style={s.stage}>
        {!unlocked && (
          <div style={s.lockOverlay}>
            <Icon name="lock" size={32} style={{ color: 'var(--accent)', marginBottom: 10 }} />
            <div style={s.lockTitle}>BREAK ROOM</div>
            <div style={s.lockMessage}>{access?.message || 'Clock into Break to unlock the arcade.'}</div>
            {access?.reason === 'WRONG_STATE' && (
              <Button variant="primary" style={{ marginTop: 16 }} disabled={startingBreak} onClick={startBreak}>
                {startingBreak ? 'STARTING…' : 'TAKE A BREAK'}
              </Button>
            )}
          </div>
        )}

        <div style={unlocked ? s.cabinetGrid : s.cabinetGridLocked}>
          {games.map((g) => (
            <Card key={g.gameType} variant={unlocked && g.enabled ? 'interactive' : 'default'} style={s.cabinet} onClick={() => unlocked && g.enabled && navigate(`${base}/break-room/play/${g.gameType}`)}>
              <div style={s.cabinetTitle}>{GAME_LABELS[g.gameType]}</div>
              <div style={s.cabinetBlurb}>{GAME_BLURBS[g.gameType]}</div>
              <div style={s.cabinetScores}>
                <ScoreLine label="You" value={g.personalBest} />
                {g.officeBest != null && <ScoreLine label="Office" value={g.officeBest} />}
                <ScoreLine label="Agency" value={g.agencyBest} />
              </div>
              {!g.enabled && <Badge tone="neutral" style={{ marginTop: 8 }}>TURNED OFF</Badge>}
              {unlocked && g.enabled && <Button variant="primary" style={{ marginTop: 10, width: '100%' }}>PLAY</Button>}
            </Card>
          ))}

          <Card variant={unlocked ? 'interactive' : 'default'} style={s.cabinet} onClick={() => unlocked && setJokeOpen(true)}>
            <div style={s.cabinetTitle}>PICK ME UP</div>
            <div style={s.cabinetBlurb}>Need a laugh? Pull one from the break room wall.</div>
            {unlocked && <Button variant="secondary" style={{ marginTop: 10, width: '100%' }}>TELL ME ONE</Button>}
          </Card>

          <Card variant="interactive" style={s.cabinet} onClick={() => setLeaderboardGame('CONGO_LINE')}>
            <div style={s.cabinetTitle}>LEADERBOARDS</div>
            <div style={s.cabinetBlurb}>See who's dominating the arcade this week.</div>
            <Button variant="secondary" style={{ marginTop: 10, width: '100%' }}>VIEW</Button>
          </Card>

          <Card variant="interactive" style={s.cabinet} onClick={() => setAchievementsOpen(true)}>
            <div style={s.cabinetTitle}>ACHIEVEMENTS</div>
            <div style={s.cabinetBlurb}>Trophies waiting to be unlocked across every game.</div>
            <Button variant="secondary" style={{ marginTop: 10, width: '100%' }}>VIEW</Button>
          </Card>
        </div>
      </div>

      {games.length === 0 && !unlocked && (
        <EmptyState title="Nothing here yet" description="Clock in and take a break to see the arcade." />
      )}

      {jokeOpen && <JokeModal onClose={() => setJokeOpen(false)} />}
      {leaderboardGame && <LeaderboardModal gameType={leaderboardGame} onChangeGame={setLeaderboardGame} onClose={() => setLeaderboardGame(null)} />}
      {achievementsOpen && <AchievementsModal onClose={() => setAchievementsOpen(false)} />}
    </div>
  );
}

function ScoreLine({ label, value }) {
  return (
    <div style={s.scoreLine}>
      <span style={s.scoreLabel}>{label}</span>
      <span style={s.scoreValue}>{value != null ? value.toLocaleString() : '—'}</span>
    </div>
  );
}

function JokeModal({ onClose }) {
  const [joke, setJoke] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchJoke(); }, []);

  async function fetchJoke() {
    setLoading(true);
    setError('');
    try {
      const data = await api.breakRoomJoke();
      setJoke(data.joke);
    } catch (err) {
      setError(err.data?.message || 'Out of jokes for now — try again in a bit.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="PICK ME UP" onClose={onClose}>
      <div style={s.jokeBox}>
        {loading ? 'Thinking of one…' : error ? error : joke?.text}
      </div>
      <Button variant="primary" style={{ marginTop: 16, width: '100%' }} disabled={loading} onClick={fetchJoke}>ANOTHER ONE</Button>
    </Modal>
  );
}

function AchievementsModal({ onClose }) {
  const [achievements, setAchievements] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.breakRoomAchievements()
      .then((data) => setAchievements(data.achievements))
      .catch((err) => setError(err.data?.message || 'Could not load achievements.'));
  }, []);

  const byGame = {};
  for (const a of achievements || []) {
    (byGame[a.gameType] = byGame[a.gameType] || []).push(a);
  }

  return (
    <Modal title="ACHIEVEMENTS" onClose={onClose} maxWidth={520}>
      {error && <div style={s.errorBox}>{error}</div>}
      {!achievements ? (
        <div style={s.muted}>Loading…</div>
      ) : (
        Object.entries(byGame).map(([gameType, defs]) => (
          <div key={gameType} style={{ marginBottom: 18 }}>
            <div style={s.achGameLabel}>{GAME_LABELS[gameType]}</div>
            {defs.map((d) => (
              <div key={d.key} style={s.achRow(d.unlocked)}>
                <span style={s.achIcon}>{d.unlocked ? '🏆' : '🔒'}</span>
                <div>
                  <div style={s.achTitle(d.unlocked)}>{d.label}</div>
                  <div style={s.achDesc}>{d.description}</div>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </Modal>
  );
}

function LeaderboardModal({ gameType, onChangeGame, onClose }) {
  const [scope, setScope] = useState('agency');
  const [period, setPeriod] = useState('all');
  const [rows, setRows] = useState([]);
  const [myRank, setMyRank] = useState(null);
  const [myBest, setMyBest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, [gameType, scope, period]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api.breakRoomLeaderboard(`?gameType=${gameType}&scope=${scope}&period=${period}`);
      setRows(data.rows);
      setMyRank(data.myRank);
      setMyBest(data.myBest);
    } catch (err) {
      setError(err.data?.message || 'Could not load this leaderboard.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="LEADERBOARDS" onClose={onClose} maxWidth={560}>
      <div style={s.lbTabs}>
        {Object.keys(GAME_LABELS).map((g) => (
          <button key={g} style={g === gameType ? s.lbTabActive : s.lbTab} onClick={() => onChangeGame(g)}>{GAME_LABELS[g]}</button>
        ))}
      </div>
      <div style={s.lbControls}>
        <select style={s.lbSelect} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="office">My Office</option>
          <option value="agency">My Agency</option>
          <option value="global">Global</option>
        </select>
        <div style={s.lbPeriods}>
          {PERIODS.map((p) => (
            <button key={p.key} style={p.key === period ? s.lbPeriodActive : s.lbPeriod} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      {error && <div style={s.errorBox}>{error}</div>}
      {loading ? (
        <div style={s.muted}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState description="No scores yet for this scope/period." />
      ) : (
        <div style={s.lbList}>
          {rows.map((r) => (
            <div key={r.userId} style={s.lbRow}>
              <span style={s.lbRank}>#{r.rank}</span>
              <span style={s.lbName}>{r.firstName} {r.lastName}</span>
              <span style={s.lbScore}>{r.score.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      {myBest != null && (
        <div style={s.myBestLine}>Your best: {myBest.toLocaleString()}{myRank ? ` (rank #${myRank})` : ''}</div>
      )}
    </Modal>
  );
}

const s = {
  wrap: {},
  errorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 14, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  championCard: { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4 },
  championLabel: { fontSize: 12, fontWeight: 800, letterSpacing: 1, color: 'var(--text-secondary)' },
  championLine: { fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 },
  stage: { position: 'relative' },
  lockOverlay: {
    position: 'absolute', inset: 0, zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', background: 'rgba(6, 7, 9, 0.72)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
    borderRadius: 'var(--radius-lg)', padding: 24,
  },
  lockTitle: { fontSize: 22, fontWeight: 900, letterSpacing: 2, color: 'var(--text-primary)' },
  lockMessage: { color: 'var(--text-muted)', fontSize: 13, marginTop: 6, maxWidth: 320 },
  cabinetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 },
  cabinetGridLocked: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, filter: 'blur(3px)', opacity: 0.5, pointerEvents: 'none', userSelect: 'none' },
  cabinet: { display: 'flex', flexDirection: 'column' },
  cabinetTitle: { fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: 0.5 },
  cabinetBlurb: { color: 'var(--text-muted)', fontSize: 12, marginTop: 4, minHeight: 32 },
  cabinetScores: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 },
  scoreLine: { display: 'flex', justifyContent: 'space-between', fontSize: 11 },
  scoreLabel: { color: 'var(--text-muted)' },
  scoreValue: { color: 'var(--text-secondary)', fontWeight: 700 },
  muted: { color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 },
  jokeBox: { color: 'var(--text-primary)', fontSize: 15, lineHeight: 1.5, textAlign: 'center', padding: '20px 10px', minHeight: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  lbTabs: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  lbTab: { padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  lbTabActive: { padding: '6px 12px', borderRadius: 999, border: 'none', background: 'var(--accent-gradient)', color: 'var(--accent-on)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  lbControls: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 },
  lbSelect: { padding: '6px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  lbPeriods: { display: 'flex', gap: 4 },
  lbPeriod: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer' },
  lbPeriodActive: { padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--accent-gradient)', color: 'var(--accent-on)', fontSize: 10, fontWeight: 700, cursor: 'pointer' },
  lbList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' },
  lbRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--bg-sunken)', borderRadius: 8 },
  lbRank: { color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, width: 32 },
  lbName: { flex: 1, color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
  lbScore: { color: 'var(--accent)', fontWeight: 800, fontSize: 13 },
  myBestLine: { marginTop: 14, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 },
  achGameLabel: { fontSize: 11, fontWeight: 800, letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' },
  achRow: (unlocked) => ({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', opacity: unlocked ? 1 : 0.55 }),
  achIcon: { fontSize: 18, width: 24, textAlign: 'center', flexShrink: 0 },
  achTitle: (unlocked) => ({ fontSize: 13, fontWeight: 700, color: unlocked ? 'var(--text-primary)' : 'var(--text-muted)' }),
  achDesc: { fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
};
