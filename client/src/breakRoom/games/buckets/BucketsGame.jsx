import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui';

// Buckets — an original 60-second shot-timing game: a ball bounces back
// and forth along a meter and you shoot (tap/space) when it's over the
// target bands. No borrowed rules, art, or branding from any existing
// basketball title.

const ROUND_MS = 60000;
const BASE_SPEED = 0.9; // percent of bar per ms, roughly
const MAX_SPEED = 2.6;

function zoneFor(pos) {
  if (pos >= 47 && pos <= 53) return { zone: 'PERFECT', points: 50 };
  if (pos >= 38 && pos <= 62) return { zone: 'GREEN', points: 30 };
  if (pos >= 28 && pos <= 72) return { zone: 'YELLOW', points: 15 };
  return { zone: 'MISS', points: 0 };
}

export default function BucketsGame({ onScoreUpdate, onGameOver }) {
  const indicatorRef = useRef(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_MS / 1000);
  const [lastShot, setLastShot] = useState(null);

  const stateRef = useRef(null);
  const overRef = useRef(false);

  useEffect(() => {
    const startedAt = performance.now();
    stateRef.current = {
      pos: 0,
      dir: 1,
      score: 0,
      streak: 0,
      bestStreak: 0,
      shotsMade: 0,
      shotsAttempted: 0,
      lastTs: null,
    };
    overRef.current = false;

    function handleKey(e) {
      if (e.code === 'Space') {
        e.preventDefault();
        shoot();
      }
    }
    window.addEventListener('keydown', handleKey);

    let frameId;
    function frame(ts) {
      if (overRef.current) return;
      const st = stateRef.current;
      if (st.lastTs == null) st.lastTs = ts;
      const dt = ts - st.lastTs;
      st.lastTs = ts;

      const elapsed = ts - startedAt;
      const remaining = Math.max(0, ROUND_MS - elapsed);
      const sec = Math.ceil(remaining / 1000);
      setSecondsLeft((prev) => (prev !== sec ? sec : prev));

      if (remaining <= 0) {
        return endGame(st);
      }

      const speed = Math.min(MAX_SPEED, BASE_SPEED + st.shotsAttempted * 0.04);
      st.pos += st.dir * speed * (dt / 16.67);
      if (st.pos >= 100) { st.pos = 100; st.dir = -1; }
      if (st.pos <= 0) { st.pos = 0; st.dir = 1; }

      if (indicatorRef.current) indicatorRef.current.style.left = `${st.pos}%`;
      frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);

    function shoot() {
      const st = stateRef.current;
      if (overRef.current) return;
      const { zone, points } = zoneFor(st.pos);
      st.shotsAttempted += 1;
      if (zone === 'MISS') {
        st.streak = 0;
      } else {
        st.shotsMade += 1;
        st.streak += 1;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        const multiplier = 1 + Math.floor(st.streak / 3) * 0.5;
        st.score += Math.round(points * Math.min(multiplier, 3));
      }
      setScore(st.score);
      setStreak(st.streak);
      setLastShot(zone);
      onScoreUpdate(st.score, { shotsMade: st.shotsMade, shotsAttempted: st.shotsAttempted, bestStreak: st.bestStreak });
    }

    function endGame(st) {
      overRef.current = true;
      onGameOver(st.score, { shotsMade: st.shotsMade, shotsAttempted: st.shotsAttempted, bestStreak: st.bestStreak });
    }

    // Expose shoot() to the tap button below without re-binding on every render.
    stateRef.current.shoot = shoot;

    return () => {
      window.removeEventListener('keydown', handleKey);
      cancelAnimationFrame(frameId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={s.wrap}>
      <div style={s.hud}>
        <div style={s.hudItem}>SCORE <b>{score.toLocaleString()}</b></div>
        <div style={s.hudItem}>STREAK <b>{streak}</b></div>
        <div style={s.hudItem}>TIME <b>{secondsLeft}s</b></div>
      </div>

      <div style={s.track}>
        <div style={{ ...s.band, ...s.bandYellow, left: '28%', width: '44%' }} />
        <div style={{ ...s.band, ...s.bandGreen, left: '38%', width: '24%' }} />
        <div style={{ ...s.band, ...s.bandPerfect, left: '47%', width: '6%' }} />
        <div ref={indicatorRef} style={s.indicator} />
      </div>

      {lastShot && <div style={s.feedback(lastShot)}>{lastShot}</div>}

      <Button variant="primary" style={s.shootButton} onClick={() => stateRef.current?.shoot()}>SHOOT (SPACE)</Button>
      <div style={s.hint}>Hit it when the ball crosses the green/perfect band.</div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 24, maxWidth: 480, margin: '0 auto' },
  hud: { display: 'flex', gap: 20, color: 'var(--text-secondary)', fontSize: 13 },
  hudItem: {},
  track: { position: 'relative', width: '100%', height: 36, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 999, overflow: 'hidden' },
  band: { position: 'absolute', top: 0, bottom: 0 },
  bandYellow: { background: 'rgba(255, 184, 77, 0.25)' },
  bandGreen: { background: 'rgba(198, 255, 46, 0.3)' },
  bandPerfect: { background: 'rgba(198, 255, 46, 0.75)' },
  indicator: { position: 'absolute', top: -4, width: 14, height: 44, borderRadius: 999, background: '#fff', transform: 'translateX(-50%)', boxShadow: '0 0 10px rgba(255,255,255,0.6)' },
  feedback: (zone) => ({
    fontSize: 14, fontWeight: 800, letterSpacing: 1,
    color: zone === 'MISS' ? 'var(--danger)' : zone === 'PERFECT' ? 'var(--accent)' : 'var(--text-secondary)',
  }),
  shootButton: { width: '100%', padding: '14px 0', fontSize: 15 },
  hint: { color: 'var(--text-muted)', fontSize: 11 },
};
