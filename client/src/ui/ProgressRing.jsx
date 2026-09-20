// SVG radial gauge with a gradient stroke — references the shared
// #accent-gradient defined once by <GradientDefs/> at the app root.
export default function ProgressRing({ value, max = 100, size = 96, strokeWidth = 8, label }) {
  const hasValue = value !== null && value !== undefined;
  const pct = hasValue ? Math.max(0, Math.min(1, value / max)) : 0;
  const r = (size - strokeWidth) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * pct;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--border-hairline)" strokeWidth={strokeWidth} />
        {hasValue && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="url(#accent-gradient)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.28, fontWeight: 700, color: 'var(--text-primary)' }}>
          {hasValue ? value : '—'}
        </div>
        {label && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{label}</div>}
      </div>
    </div>
  );
}
