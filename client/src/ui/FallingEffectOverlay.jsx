import { useEffect, useRef } from 'react';

// MySpace-style falling-object overlay for the Personalize page. Pure
// canvas + requestAnimationFrame, no dependency — this app already has no
// charting library and no canvas code anywhere (confirmed before building
// this), so a small hand-rolled particle loop matches the "no new
// dependency for a small visual" precedent the rest of client/src/ui/ sets
// (BarRow/Sparkline are the same kind of hand-built SVG primitive).
const GLYPH_EFFECTS = {
  HEARTS: ['❤️', '💚', '💛'],
  STARS: ['⭐', '✨', '🌟'],
  SNOW: ['❄️', '❅', '❆'],
  MONEY: ['💵', '💰', '💸'],
  FIRE: ['🔥'],
};

// CONFETTI/BUBBLES are drawn as vector shapes rather than emoji, for a
// bit of visual variety among the eight options.
const SHAPE_EFFECTS = new Set(['CONFETTI', 'BUBBLES']);
const CONFETTI_COLORS = ['#c6ff2e', '#16e0a0', '#ff6b6b', '#4ea8ff', '#ffd166'];

const MAX_PARTICLES = 42;

function makeParticle(effect, width, height, spawnAtTop) {
  const glyphs = GLYPH_EFFECTS[effect];
  return {
    x: Math.random() * width,
    y: spawnAtTop ? -20 - Math.random() * height : Math.random() * height,
    size: effect === 'BUBBLES' ? 8 + Math.random() * 18 : 16 + Math.random() * 14,
    vy: 0.6 + Math.random() * 1.4,
    vx: (Math.random() - 0.5) * 0.6,
    drift: Math.random() * Math.PI * 2,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.04,
    glyph: glyphs ? glyphs[Math.floor(Math.random() * glyphs.length)] : null,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    opacity: 0.6 + Math.random() * 0.4,
  };
}

function drawParticle(ctx, effect, p) {
  ctx.save();
  ctx.globalAlpha = p.opacity;
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  if (effect === 'CONFETTI') {
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
  } else if (effect === 'BUBBLES') {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else if (p.glyph) {
    ctx.font = `${p.size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.glyph, 0, 0);
  }
  ctx.restore();
}

// effect: one of the FallingEffect enum values ('NONE' renders nothing).
export default function FallingEffectOverlay({ effect }) {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);

  useEffect(() => {
    if (!effect || effect === 'NONE') return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let width = window.innerWidth;
    let height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    particlesRef.current = Array.from({ length: MAX_PARTICLES }, () => makeParticle(effect, width, height, true));

    function handleResize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    }
    window.addEventListener('resize', handleResize);

    let frameId;
    function tick() {
      ctx.clearRect(0, 0, width, height);
      for (const p of particlesRef.current) {
        p.y += p.vy;
        p.drift += 0.02;
        p.x += p.vx + Math.sin(p.drift) * 0.4;
        p.rotation += p.rotationSpeed;
        if (p.y > height + 30) Object.assign(p, makeParticle(effect, width, height, false), { y: -20 });
        if (p.x < -30) p.x = width + 30;
        if (p.x > width + 30) p.x = -30;
        drawParticle(ctx, effect, p);
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [effect]);

  if (!effect || effect === 'NONE') return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 9000,
      }}
    />
  );
}

export const FALLING_EFFECTS = ['NONE', 'HEARTS', 'STARS', 'SNOW', 'MONEY', 'BUBBLES', 'CONFETTI', 'FIRE'];
export const FALLING_EFFECT_LABELS = {
  NONE: 'None',
  HEARTS: 'Hearts',
  STARS: 'Stars',
  SNOW: 'Snow',
  MONEY: 'Money',
  BUBBLES: 'Bubbles',
  CONFETTI: 'Confetti',
  FIRE: 'Fire',
};
