import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui';

// Congo Line — an original grid-chase game (not a reskin of any existing
// title's code, rules, art, or branding): grow a conga line of dancing
// office coworkers around the break room floor, picking up collectibles
// and power-ups, until you run into your own line or (outside After
// Hours) the wall.

const GRID_W = 22;
const GRID_H = 14;
const CELL = 22;
const BASE_TICK_MS = 160;
const MIN_TICK_MS = 70;

const DIRS = { UP: { x: 0, y: -1 }, DOWN: { x: 0, y: 1 }, LEFT: { x: -1, y: 0 }, RIGHT: { x: 1, y: 0 } };
const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const POWERUPS = [
  { key: 'COFFEE', glyph: '☕', weight: 4 },
  { key: 'ENERGY_DRINK', glyph: '🥤', weight: 3 },
  { key: 'HEADSET', glyph: '🎧', weight: 3 },
  { key: 'COMMISSION_CHECK', glyph: '💵', weight: 2 },
  { key: 'AFTER_HOURS', glyph: '🌙', weight: 1 },
];
const POWERUP_SPAWN_CHANCE = 0.22; // rolled each time a dancer is collected
const POWERUP_LIFESPAN_MS = 7000;

function randCell(occupied) {
  let cell;
  do {
    cell = { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
  } while (occupied.some((o) => o.x === cell.x && o.y === cell.y));
  return cell;
}

function pickPowerup() {
  const total = POWERUPS.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of POWERUPS) {
    if (r < p.weight) return p.key;
    r -= p.weight;
  }
  return POWERUPS[0].key;
}

export default function CongoLineGame({ onScoreUpdate, onGameOver }) {
  const canvasRef = useRef(null);
  const [score, setScore] = useState(0);
  const [dancers, setDancers] = useState(0);
  const [effects, setEffects] = useState({});

  // Mutable game state lives in refs — this is a fixed-tick simulation
  // driven by requestAnimationFrame's delta time, not React state, so a
  // render never gets skipped or doubled relative to the simulation.
  const stateRef = useRef(null);
  const overRef = useRef(false);

  useEffect(() => {
    const snakeStart = [{ x: 8, y: 7 }, { x: 7, y: 7 }, { x: 6, y: 7 }];
    stateRef.current = {
      snake: snakeStart,
      dir: 'RIGHT',
      queuedDir: 'RIGHT',
      food: randCell(snakeStart),
      powerup: null,
      powerupSpawnedAt: 0,
      active: {}, // key -> expiresAt (ms epoch)
      score: 0,
      dancers: 0,
      multiplier: 1,
      accMs: 0,
      lastTs: null,
    };
    overRef.current = false;

    function handleKey(e) {
      const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT' };
      const dir = map[e.key];
      if (!dir) return;
      const st = stateRef.current;
      if (OPPOSITE[dir] === st.dir) return;
      st.queuedDir = dir;
      e.preventDefault();
    }
    window.addEventListener('keydown', handleKey);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = GRID_W * CELL;
    canvas.height = GRID_H * CELL;

    let frameId;
    function frame(ts) {
      if (overRef.current) return;
      const st = stateRef.current;
      if (st.lastTs == null) st.lastTs = ts;
      const dt = ts - st.lastTs;
      st.lastTs = ts;
      st.accMs += dt;

      const now = Date.now();
      for (const key of Object.keys(st.active)) {
        if (st.active[key] <= now) delete st.active[key];
      }

      const speedBoost = !!st.active.COFFEE;
      const tickMs = Math.max(MIN_TICK_MS, BASE_TICK_MS - st.dancers * 2.5) * (speedBoost ? 0.55 : 1);

      while (st.accMs >= tickMs) {
        st.accMs -= tickMs;
        tickSimulation(st, now);
        if (overRef.current) break;
      }

      render(ctx, st);
      setEffects({ ...st.active });
      if (!overRef.current) frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);

    function tickSimulation(st, now) {
      st.dir = st.queuedDir;
      const d = DIRS[st.dir];
      const head = st.snake[0];
      let nx = head.x + d.x;
      let ny = head.y + d.y;

      const afterHours = !!st.active.AFTER_HOURS;
      if (afterHours) {
        nx = (nx + GRID_W) % GRID_W;
        ny = (ny + GRID_H) % GRID_H;
      } else if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
        return endGame(st);
      }

      const invincible = !!st.active.ENERGY_DRINK;
      const hitsSelf = st.snake.some((seg) => seg.x === nx && seg.y === ny);
      if (hitsSelf && !invincible) return endGame(st);

      const newHead = { x: nx, y: ny };
      const ateFood = st.food.x === nx && st.food.y === ny;
      st.snake = [newHead, ...st.snake];
      if (!ateFood) st.snake.pop();

      if (ateFood) {
        st.dancers += 1;
        st.multiplier = st.active.HEADSET ? 2 : 1;
        st.score += 100 * st.multiplier;
        st.food = randCell(st.snake);
        if (Math.random() < POWERUP_SPAWN_CHANCE && !st.powerup) {
          st.powerup = { ...randCell([...st.snake, st.food]), key: pickPowerup() };
          st.powerupSpawnedAt = now;
        }
        setScore(st.score);
        setDancers(st.dancers);
        onScoreUpdate(st.score, { dancersCollected: st.dancers });
      }

      if (st.powerup && st.powerup.x === nx && st.powerup.y === ny) {
        applyPowerup(st, st.powerup.key, now);
        st.powerup = null;
      }
      if (st.powerup && now - st.powerupSpawnedAt > POWERUP_LIFESPAN_MS) {
        st.powerup = null;
      }
    }

    function applyPowerup(st, key, now) {
      if (key === 'COMMISSION_CHECK') {
        st.score += 500;
        setScore(st.score);
        onScoreUpdate(st.score, { dancersCollected: st.dancers });
        return;
      }
      const durations = { COFFEE: 6000, ENERGY_DRINK: 5000, HEADSET: 8000, AFTER_HOURS: 6000 };
      st.active[key] = now + (durations[key] || 5000);
    }

    function endGame(st) {
      overRef.current = true;
      onGameOver(st.score, { dancersCollected: st.dancers });
    }

    return () => {
      window.removeEventListener('keydown', handleKey);
      cancelAnimationFrame(frameId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function press(dir) {
    const st = stateRef.current;
    if (!st || OPPOSITE[dir] === st.dir) return;
    st.queuedDir = dir;
  }

  return (
    <div style={s.wrap}>
      <div style={s.hud}>
        <div style={s.hudItem}>SCORE <b>{score.toLocaleString()}</b></div>
        <div style={s.hudItem}>DANCERS <b>{dancers}</b></div>
        {effects.HEADSET && <span style={s.badge}>🎧 2x</span>}
        {effects.COFFEE && <span style={s.badge}>☕ FAST</span>}
        {effects.ENERGY_DRINK && <span style={s.badge}>🥤 PHASE</span>}
        {effects.AFTER_HOURS && <span style={s.badge}>🌙 NO WALLS</span>}
      </div>
      <canvas ref={canvasRef} style={s.canvas} />
      <div style={s.dpad}>
        <div />
        <Button variant="secondary" size="sm" onClick={() => press('UP')}>↑</Button>
        <div />
        <Button variant="secondary" size="sm" onClick={() => press('LEFT')}>←</Button>
        <Button variant="secondary" size="sm" onClick={() => press('DOWN')}>↓</Button>
        <Button variant="secondary" size="sm" onClick={() => press('RIGHT')}>→</Button>
      </div>
      <div style={s.hint}>Arrow keys / WASD, or the pad below.</div>
    </div>
  );
}

function render(ctx, st) {
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, GRID_W * CELL, GRID_H * CELL);

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let x = 0; x <= GRID_W; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, GRID_H * CELL); ctx.stroke();
  }
  for (let y = 0; y <= GRID_H; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(GRID_W * CELL, y * CELL); ctx.stroke();
  }

  st.snake.forEach((seg, i) => {
    ctx.fillStyle = i === 0 ? '#c6ff2e' : `rgba(198, 255, 46, ${Math.max(0.35, 1 - i * 0.05)})`;
    ctx.beginPath();
    ctx.roundRect(seg.x * CELL + 2, seg.y * CELL + 2, CELL - 4, CELL - 4, 6);
    ctx.fill();
  });

  ctx.font = `${CELL - 4}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💃', st.food.x * CELL + CELL / 2, st.food.y * CELL + CELL / 2 + 1);

  if (st.powerup) {
    const def = POWERUPS.find((p) => p.key === st.powerup.key);
    ctx.fillText(def.glyph, st.powerup.x * CELL + CELL / 2, st.powerup.y * CELL + CELL / 2 + 1);
  }
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 16 },
  hud: { display: 'flex', gap: 16, alignItems: 'center', color: 'var(--text-secondary)', fontSize: 13 },
  hudItem: { color: 'var(--text-secondary)' },
  badge: { background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: 'var(--accent)' },
  canvas: { borderRadius: 10, border: '1px solid var(--border-hairline)', maxWidth: '100%' },
  dpad: { display: 'grid', gridTemplateColumns: 'repeat(3, 44px)', gridTemplateRows: 'repeat(2, 44px)', gap: 6, marginTop: 4 },
  hint: { color: 'var(--text-muted)', fontSize: 11 },
};
