// tone picks which tinted block this tile renders as — "grey" (default,
// a neutral block), "green"/"lime" (the two brand hues, for a stat worth
// calling out), "white", or "danger" for a genuinely bad number (e.g. a
// blown speed-to-lead SLA) that needs to visually stand out from a
// normal stat. Every tile renders as a real color block now instead of
// bare floating text, so a row of stats reads as distinct tiles.
const TILE_TONES = {
  green: { bg: 'var(--surface-tint-green)', border: 'var(--surface-tint-green-border)' },
  lime: { bg: 'var(--surface-tint-lime)', border: 'var(--surface-tint-lime-border)' },
  grey: { bg: 'var(--surface-tint-grey)', border: 'var(--surface-tint-grey-border)' },
  white: { bg: 'var(--surface-tint-white)', border: 'var(--surface-tint-white-border)' },
  danger: { bg: 'var(--danger-soft)', border: 'rgba(255, 77, 94, 0.35)' },
};

export default function StatTile({ label, value, sub, onClick, tone = 'grey' }) {
  const clickable = typeof onClick === 'function';
  const danger = tone === 'danger';
  const t = TILE_TONES[tone] || TILE_TONES.grey;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        minWidth: 120,
        cursor: clickable ? 'pointer' : 'default',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: t.bg,
        border: `1px solid ${t.border}`,
      }}
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
