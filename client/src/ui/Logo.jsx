import { useId } from 'react';

// The one EvenFlow brand mark — a solid, gradient-filled lightning bolt
// paired with a two-tone wordmark ("EVEN" gradient-clipped, "FLOW" in the
// primary text color). Used everywhere the brand appears: Sidebar,
// MobileTopBar, MobileDrawer, and the Login page's larger "hero" variant.
// Login renders outside AppLayout (where the shared #accent-gradient def
// lives), so each instance defines its own local gradient via a unique
// useId() instead of depending on that external mount — same stop colors
// as tokens.css's --accent/--accent-2, kept in sync manually.
function BoltMark({ size, glow }) {
  const gradId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={
        glow
          ? { filter: 'drop-shadow(0 0 10px rgba(198, 255, 46, 0.55)) drop-shadow(0 0 28px rgba(22, 224, 160, 0.35))' }
          : undefined
      }
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c6ff2e" />
          <stop offset="100%" stopColor="#16e0a0" />
        </linearGradient>
      </defs>
      <polygon points="13 1 3 14 11 14 10 23 21 9 12 9 13 1" fill={`url(#${gradId})`} />
    </svg>
  );
}

const SIZES = {
  sm: { bolt: 16, text: 14, gap: 6, letterSpacing: 0.5 }, // mobile top bar
  md: { bolt: 20, text: 18, gap: 8, letterSpacing: 1 }, // sidebar
  lg: { bolt: 88, text: 34, gap: 16, letterSpacing: 2 }, // login hero
};

export default function Logo({ variant = 'inline', size = 'md', tagline, style }) {
  const dims = SIZES[size] || SIZES.md;
  const hero = variant === 'hero';

  const wordmark = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: Math.round(dims.gap * 0.4), justifyContent: hero ? 'center' : 'flex-start' }}>
      <span style={s.even(dims)}>EVEN</span>
      <span style={s.flow(dims)}>FLOW</span>
    </div>
  );

  if (hero) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: dims.gap, ...style }}>
        <BoltMark size={dims.bolt} glow />
        {wordmark}
        {tagline && <div style={s.tagline}>{tagline}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: dims.gap, ...style }}>
      <BoltMark size={dims.bolt} />
      {wordmark}
    </div>
  );
}

const s = {
  even: (dims) => ({
    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: dims.text, letterSpacing: dims.letterSpacing,
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  }),
  flow: (dims) => ({
    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: dims.text, letterSpacing: dims.letterSpacing,
    color: 'var(--text-primary)',
  }),
  tagline: {
    fontFamily: 'var(--font-body)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase',
    color: 'var(--text-muted)', fontWeight: 600, textAlign: 'center', marginTop: 2,
    maxWidth: 320, padding: '0 16px',
  },
};
