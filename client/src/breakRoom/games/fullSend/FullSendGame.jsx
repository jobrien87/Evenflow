import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui';

// Full Send — an original side-scrolling desk-chair motocross game:
// procedurally generated rolling terrain, lightweight jump/rotation
// physics, boost pickups, and trick scoring. Not a reskin of any existing
// title's code, rules, art, or branding.

const WIDTH = 520;
const HEIGHT = 300;
const GROUND_BASE = 190;
const GRAVITY = 0.0022;
const JUMP_VELOCITY = 0.62;
const ROTATE_SPEED = 0.006;
const BASE_FORWARD_SPEED = 0.26;
const BOOST_FORWARD_SPEED = 0.46;
const BOOST_DURATION_MS = 3500;
const LANDING_TOLERANCE_RAD = (35 * Math.PI) / 180;
const BIKE_SCREEN_X = 150;

function terrainHeight(x) {
  return (
    GROUND_BASE +
    40 * Math.sin(x * 0.0035) +
    16 * Math.sin(x * 0.012 + 1.3) +
    8 * Math.sin(x * 0.045 + 2.7)
  );
}

function terrainSlope(x) {
  const h1 = terrainHeight(x - 4);
  const h2 = terrainHeight(x + 4);
  return Math.atan2(h2 - h1, 8);
}

function normalizeAngle(a) {
  let n = a % (Math.PI * 2);
  if (n < 0) n += Math.PI * 2;
  return n;
}

export default function FullSendGame({ onScoreUpdate, onGameOver }) {
  const canvasRef = useRef(null);
  const [score, setScore] = useState(0);
  const [tricksLanded, setTricksLanded] = useState(0);
  const [boosting, setBoosting] = useState(false);

  const stateRef = useRef(null);
  const overRef = useRef(false);

  useEffect(() => {
    const st = {
      worldX: 0,
      altitude: 0, // 0 = on ground, positive = above ground
      vAlt: 0,
      rotation: 0,
      airborneRotationStart: 0,
      airborne: false,
      boostUntil: 0,
      nextBoostAt: 600 + Math.random() * 400,
      score: 0,
      tricksLanded: 0,
      lastTs: null,
      keys: {},
    };
    stateRef.current = st;
    overRef.current = false;

    function jump() {
      if (st.airborne || overRef.current) return;
      st.airborne = true;
      st.vAlt = JUMP_VELOCITY;
      st.airborneRotationStart = st.rotation;
    }

    function handleKeyDown(e) {
      st.keys[e.key] = true;
      if (e.key === 'ArrowUp' || e.code === 'Space') { jump(); e.preventDefault(); }
    }
    function handleKeyUp(e) { st.keys[e.key] = false; }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    function endGame() {
      overRef.current = true;
      onGameOver(st.score, { tricksLanded: st.tricksLanded, bestComboCount: st.tricksLanded, crashed: true });
    }

    let frameId;
    function frame(ts) {
      if (overRef.current) return;
      if (st.lastTs == null) st.lastTs = ts;
      const dt = Math.min(48, ts - st.lastTs);
      st.lastTs = ts;

      const boostActive = ts < st.boostUntil;
      if (boostActive !== (st.lastBoostFlag || false)) { st.lastBoostFlag = boostActive; setBoosting(boostActive); }
      const forwardSpeed = boostActive ? BOOST_FORWARD_SPEED : BASE_FORWARD_SPEED;
      st.worldX += forwardSpeed * dt;

      if (st.worldX >= st.nextBoostAt && !st.airborne) {
        st.boostUntil = ts + BOOST_DURATION_MS;
        st.score += 200;
        st.nextBoostAt = st.worldX + 500 + Math.random() * 500;
        setScore(st.score);
        onScoreUpdate(st.score, { tricksLanded: st.tricksLanded });
      }

      if (st.airborne) {
        if (st.keys.ArrowLeft) st.rotation -= ROTATE_SPEED * dt;
        if (st.keys.ArrowRight) st.rotation += ROTATE_SPEED * dt;
        st.vAlt -= GRAVITY * dt;
        st.altitude += st.vAlt * dt;
        if (st.altitude <= 0) {
          st.altitude = 0;
          const slope = terrainSlope(st.worldX);
          const diff = Math.abs(normalizeAngle(st.rotation - slope + Math.PI) - Math.PI);
          const spun = Math.abs(st.rotation - st.airborneRotationStart);
          if (diff > LANDING_TOLERANCE_RAD) {
            return endGame();
          }
          const flips = Math.floor(spun / (Math.PI * 2));
          if (flips > 0) {
            st.tricksLanded += flips;
            st.score += flips * 300;
            setTricksLanded(st.tricksLanded);
          }
          st.rotation = slope;
          st.airborne = false;
          st.vAlt = 0;
        }
      } else {
        const slope = terrainSlope(st.worldX);
        st.rotation += (slope - st.rotation) * Math.min(1, dt * 0.02);
      }

      st.score += forwardSpeed * dt * 0.12;
      setScore(Math.round(st.score));
      onScoreUpdate(Math.round(st.score), { tricksLanded: st.tricksLanded });

      render(ctx, st);
      if (!overRef.current) frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);

    stateRef.current.doJump = jump;

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      cancelAnimationFrame(frameId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function holdRotate(key, on) {
    if (stateRef.current) stateRef.current.keys[key] = on;
  }

  return (
    <div style={s.wrap}>
      <div style={s.hud}>
        <div style={s.hudItem}>SCORE <b>{score.toLocaleString()}</b></div>
        <div style={s.hudItem}>TRICKS <b>{tricksLanded}</b></div>
        {boosting && <span style={s.boostBadge}>⚡ BOOST</span>}
      </div>
      <canvas ref={canvasRef} style={s.canvas} />
      <div style={s.controls}>
        <Button
          variant="secondary" size="sm"
          onPointerDown={() => holdRotate('ArrowLeft', true)} onPointerUp={() => holdRotate('ArrowLeft', false)} onPointerLeave={() => holdRotate('ArrowLeft', false)}
        >← SPIN</Button>
        <Button variant="primary" size="sm" onClick={() => stateRef.current?.doJump()}>JUMP</Button>
        <Button
          variant="secondary" size="sm"
          onPointerDown={() => holdRotate('ArrowRight', true)} onPointerUp={() => holdRotate('ArrowRight', false)} onPointerLeave={() => holdRotate('ArrowRight', false)}
        >SPIN →</Button>
      </div>
      <div style={s.hint}>Up/Space to jump, hold Left/Right in the air to flip. Land clean or crash the quarter.</div>
    </div>
  );
}

function render(ctx, st) {
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const camOffset = st.worldX - BIKE_SCREEN_X;
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT);
  for (let sx = 0; sx <= WIDTH; sx += 6) {
    const wx = camOffset + sx;
    ctx.lineTo(sx, terrainHeight(wx));
  }
  ctx.lineTo(WIDTH, HEIGHT);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, 'rgba(198, 255, 46, 0.18)');
  grad.addColorStop(1, 'rgba(198, 255, 46, 0.04)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(198, 255, 46, 0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (st.worldX < st.nextBoostAt && st.nextBoostAt - camOffset < WIDTH + 40) {
    const bx = st.nextBoostAt - camOffset;
    const by = terrainHeight(st.nextBoostAt) - 26;
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚡', bx, by);
  }

  const bikeScreenY = terrainHeight(st.worldX) - st.altitude;
  ctx.save();
  ctx.translate(BIKE_SCREEN_X, bikeScreenY);
  ctx.rotate(st.rotation);
  ctx.fillStyle = '#c6ff2e';
  ctx.beginPath();
  ctx.roundRect(-18, -10, 36, 14, 4);
  ctx.fill();
  ctx.fillStyle = '#1a1b1f';
  ctx.beginPath(); ctx.arc(-14, 8, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(14, 8, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 16 },
  hud: { display: 'flex', gap: 16, alignItems: 'center', color: 'var(--text-secondary)', fontSize: 13 },
  hudItem: {},
  boostBadge: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: 'var(--accent)' },
  canvas: { borderRadius: 10, border: '1px solid var(--border-hairline)', maxWidth: '100%' },
  controls: { display: 'flex', gap: 10 },
  hint: { color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', maxWidth: 380 },
};
