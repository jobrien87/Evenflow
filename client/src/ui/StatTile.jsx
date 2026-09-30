// tone="danger" swaps the default gradient-clipped number for a flat
// warning-red one — used to make a genuinely bad number (e.g. a blown
// speed-to-lead SLA) visually obvious instead of reading the same as any
// other stat.
export default function StatTile({ label, value, sub, onClick, tone }) {
  const clickable = typeof onClick === 'function';
  const danger = tone === 'danger';
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{ minWidth: 100, cursor: clickable ? 'pointer' : 'default', padding: 'var(--space-2) 0' }}
    >
      <div
        style={
          danger
            ? { fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 700, color: 'var(--danger)' }
            : {
                fontFamily: 'var(--font-display)',
                fontSize: 26,
                fontWeight: 700,
                backgroundImage: 'var(--accent-gradient)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }
        }
      >
        {value}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
