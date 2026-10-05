import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui';

// Pill Pop — an original falling-block color-match puzzle: clear the
// office's CRM "bugs" by dropping two-color capsules and lining up 4+ of
// the same color in a row or column. Not a reskin of any existing
// title's code, rules, art, or branding.

const COLS = 8;
const ROWS = 14;
const CELL = 26;
const BASE_TICK_MS = 700;
const MIN_TICK_MS = 170;

const COLORS = [
  { key: 'R', fill: '#ff6b6b', glyph: '🐞' },
  { key: 'G', fill: '#c6ff2e', glyph: '🦗' },
  { key: 'B', fill: '#4ea8ff', glyph: '🪳' },
  { key: 'Y', fill: '#ffd166', glyph: '🐜' },
];
const colorByKey = Object.fromEntries(COLORS.map((c) => [c.key, c]));

function randColorKey() {
  return COLORS[Math.floor(Math.random() * COLORS.length)].key;
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function seedBugs(grid, count) {
  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 20) {
    guard++;
    const r = ROWS - 1 - Math.floor(Math.random() * Math.floor(ROWS * 0.55));
    const c = Math.floor(Math.random() * COLS);
    if (!grid[r][c]) {
      grid[r][c] = { color: randColorKey(), isBug: true };
      placed++;
    }
  }
}

function scanLine(colors) {
  const matched = [];
  let i = 0;
  while (i < colors.length) {
    if (colors[i] == null) { i++; continue; }
    let j = i;
    while (j < colors.length && colors[j] === colors[i]) j++;
    if (j - i >= 4) for (let k = i; k < j; k++) matched.push(k);
    i = j;
  }
  return matched;
}

function findMatches(grid) {
  const matched = new Set();
  for (let r = 0; r < ROWS; r++) {
    const line = grid[r].map((cell) => cell?.color ?? null);
    for (const c of scanLine(line)) matched.add(`${r},${c}`);
  }
  for (let c = 0; c < COLS; c++) {
    const line = grid.map((row) => row[c]?.color ?? null);
    for (const r of scanLine(line)) matched.add(`${r},${c}`);
  }
  return matched;
}

function collapseColumns(grid) {
  for (let c = 0; c < COLS; c++) {
    const stack = [];
    for (let r = ROWS - 1; r >= 0; r--) if (grid[r][c]) stack.push(grid[r][c]);
    for (let i = 0; i < stack.length; i++) grid[ROWS - 1 - i][c] = stack[i];
    for (let r = 0; r < ROWS - stack.length; r++) grid[r][c] = null;
  }
}

function hasAnyBug(grid) {
  return grid.some((row) => row.some((cell) => cell?.isBug));
}

function spawnPiece() {
  const anchor = { r: 1, c: Math.floor(COLS / 2) };
  return { anchor, orientation: 'VERTICAL', colorA: randColorKey(), colorB: randColorKey() };
}

// Returns the two {r,c} cells of a piece given its anchor+orientation.
function pieceCells(piece) {
  const { anchor, orientation } = piece;
  const second = orientation === 'VERTICAL' ? { r: anchor.r - 1, c: anchor.c } : { r: anchor.r, c: anchor.c + 1 };
  return [anchor, second];
}

function inBounds(cell) {
  return cell.r >= 0 && cell.r < ROWS && cell.c >= 0 && cell.c < COLS;
}

function cellsFree(grid, cells) {
  return cells.every((cell) => inBounds(cell) && !grid[cell.r][cell.c]);
}

export default function PillPopGame({ onScoreUpdate, onGameOver }) {
  const canvasRef = useRef(null);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [bugsCleared, setBugsCleared] = useState(0);

  const stateRef = useRef(null);
  const overRef = useRef(false);

  useEffect(() => {
    const grid = emptyGrid();
    seedBugs(grid, 6);
    const st = {
      grid,
      piece: spawnPiece(),
      level: 1,
      score: 0,
      bugsCleared: 0,
      accMs: 0,
      lastTs: null,
      resolving: false,
    };
    stateRef.current = st;
    overRef.current = false;

    function lockPiece() {
      const cells = pieceCells(st.piece);
      const colors = [st.piece.colorA, st.piece.colorB];
      cells.forEach((cell, i) => { st.grid[cell.r][cell.c] = { color: colors[i], isBug: false }; });
      resolveBoard();
    }

    function resolveBoard() {
      let totalCleared = 0;
      for (;;) {
        const matched = findMatches(st.grid);
        if (matched.size === 0) break;
        totalCleared += matched.size;
        for (const key of matched) {
          const [r, c] = key.split(',').map(Number);
          st.grid[r][c] = null;
        }
        collapseColumns(st.grid);
      }
      if (totalCleared > 0) {
        st.score += totalCleared * 100;
        st.bugsCleared += totalCleared;
        setScore(st.score);
        setBugsCleared(st.bugsCleared);
        onScoreUpdate(st.score, { level: st.level, bugsCleared: st.bugsCleared });
      }

      if (!hasAnyBug(st.grid)) {
        st.level += 1;
        setLevel(st.level);
        seedBugs(st.grid, Math.min(6 + st.level * 2, 70));
      }

      const next = spawnPiece();
      if (!cellsFree(st.grid, pieceCells(next))) {
        return endGame();
      }
      st.piece = next;
    }

    function endGame() {
      overRef.current = true;
      onGameOver(st.score, { level: st.level, bugsCleared: st.bugsCleared });
    }

    function tryMove(dr, dc) {
      if (overRef.current) return;
      const moved = { anchor: { r: st.piece.anchor.r + dr, c: st.piece.anchor.c + dc }, orientation: st.piece.orientation, colorA: st.piece.colorA, colorB: st.piece.colorB };
      if (cellsFree(st.grid, pieceCells(moved))) {
        st.piece = moved;
        return true;
      }
      return false;
    }

    function tryRotate() {
      if (overRef.current) return;
      const nextOrientation = st.piece.orientation === 'VERTICAL' ? 'HORIZONTAL' : 'VERTICAL';
      const rotated = { ...st.piece, orientation: nextOrientation };
      if (cellsFree(st.grid, pieceCells(rotated))) {
        st.piece = rotated;
        return;
      }
      // Simple wall kick: nudge left one column and retry once.
      const kicked = { ...rotated, anchor: { r: rotated.anchor.r, c: rotated.anchor.c - 1 } };
      if (cellsFree(st.grid, pieceCells(kicked))) st.piece = kicked;
    }

    function hardDrop() {
      if (overRef.current) return;
      while (tryMove(1, 0)) { /* keep dropping */ }
      lockPiece();
    }

    function handleKey(e) {
      if (overRef.current) return;
      if (e.key === 'ArrowLeft') { tryMove(0, -1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { tryMove(0, 1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { if (!tryMove(1, 0)) lockPiece(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { tryRotate(); e.preventDefault(); }
      else if (e.code === 'Space') { hardDrop(); e.preventDefault(); }
    }
    window.addEventListener('keydown', handleKey);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = COLS * CELL;
    canvas.height = ROWS * CELL;

    let frameId;
    function frame(ts) {
      if (overRef.current) return;
      if (st.lastTs == null) st.lastTs = ts;
      const dt = ts - st.lastTs;
      st.lastTs = ts;
      st.accMs += dt;

      const tickMs = Math.max(MIN_TICK_MS, BASE_TICK_MS - st.level * 25);
      while (st.accMs >= tickMs) {
        st.accMs -= tickMs;
        if (!tryMove(1, 0)) lockPiece();
        if (overRef.current) break;
      }

      render(ctx, st);
      if (!overRef.current) frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);

    // Expose controls for the on-screen buttons below.
    st.controls = {
      left: () => tryMove(0, -1),
      right: () => tryMove(0, 1),
      rotate: tryRotate,
      drop: hardDrop,
    };

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
        <div style={s.hudItem}>LEVEL <b>{level}</b></div>
        <div style={s.hudItem}>BUGS CLEARED <b>{bugsCleared}</b></div>
      </div>
      <canvas ref={canvasRef} style={s.canvas} />
      <div style={s.controls}>
        <Button variant="secondary" size="sm" onClick={() => stateRef.current?.controls.left()}>←</Button>
        <Button variant="secondary" size="sm" onClick={() => stateRef.current?.controls.rotate()}>ROTATE</Button>
        <Button variant="secondary" size="sm" onClick={() => stateRef.current?.controls.right()}>→</Button>
        <Button variant="primary" size="sm" onClick={() => stateRef.current?.controls.drop()}>DROP</Button>
      </div>
      <div style={s.hint}>Arrow keys to move/rotate, Space to drop.</div>
    </div>
  );
}

function render(ctx, st) {
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke(); }
  for (let y = 0; y <= ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke(); }

  function drawCell(r, c, colorKey, isBug) {
    const def = colorByKey[colorKey];
    ctx.fillStyle = def.fill;
    ctx.beginPath();
    ctx.roundRect(c * CELL + 2, r * CELL + 2, CELL - 4, CELL - 4, 6);
    ctx.fill();
    if (isBug) {
      ctx.font = `${CELL - 8}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.glyph, c * CELL + CELL / 2, r * CELL + CELL / 2 + 1);
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = st.grid[r][c];
      if (cell) drawCell(r, c, cell.color, cell.isBug);
    }
  }

  const cells = pieceCells(st.piece);
  const colors = [st.piece.colorA, st.piece.colorB];
  cells.forEach((cell, i) => drawCell(cell.r, cell.c, colors[i], false));
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 16 },
  hud: { display: 'flex', gap: 16, color: 'var(--text-secondary)', fontSize: 13 },
  hudItem: {},
  canvas: { borderRadius: 10, border: '1px solid var(--border-hairline)', maxWidth: '100%' },
  controls: { display: 'flex', gap: 8 },
  hint: { color: 'var(--text-muted)', fontSize: 11 },
};
