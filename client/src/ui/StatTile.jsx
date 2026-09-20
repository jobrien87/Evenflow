export default function StatTile({ label, value, sub, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{ minWidth: 100, cursor: clickable ? 'pointer' : 'default', padding: 'var(--space-2) 0' }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 700,
          backgroundImage: 'var(--accent-gradient)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        {value}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
