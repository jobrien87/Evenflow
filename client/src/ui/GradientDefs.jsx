// Mounted once at the app root. Every SVG primitive (ProgressRing,
// Sparkline, ...) references url(#accent-gradient) instead of redefining
// gradient stops per component. Stop colors are the literal hex of
// --accent/--accent-2 (SVG stop-color doesn't reliably read CSS custom
// properties across browsers) — keep these in sync with tokens.css.
export default function GradientDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="accent-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c6ff2e" />
          <stop offset="100%" stopColor="#16e0a0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
