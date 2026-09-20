// Small inline trend line (e.g. Flow Score history) — references the
// shared #accent-gradient from <GradientDefs/>.
export default function Sparkline({ points = [], width = 80, height = 24 }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => `${i * stepX},${height - ((p - min) / range) * height}`).join(' ');

  return (
    <svg width={width} height={height}>
      <polyline points={coords} fill="none" stroke="url(#accent-gradient)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
