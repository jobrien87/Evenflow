export default function ProgressBar({ value = 0, max = 100, height = 8 }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div
      style={{
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 999,
        height,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--accent-gradient)',
          transition: `width var(--dur-base) var(--ease-standard)`,
        }}
      />
    </div>
  );
}
