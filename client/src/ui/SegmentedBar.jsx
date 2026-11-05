// A "whole split into parts" figure (dataviz skill's segmented-bar spec) —
// no baseline, each part its own rounded block sized by share of the
// total, separated by a 2px gap rather than a border. An inline share
// label is shown only when a segment is wide enough to hold it
// comfortably; every segment's full detail (name, count, share) is always
// available via native hover title, and the caller's own legend + table
// export carry the rest — nothing is ever gated behind the inline label.
// A segment with a zero value draws nothing.
export default function SegmentedBar({ segments, total, height = 28 }) {
  const safeTotal = total || segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const visible = segments.filter((s) => s.value > 0);
  if (visible.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 2, width: '100%', height }}>
      {visible.map((s) => {
        const share = s.value / safeTotal;
        const pct = Math.round(share * 100);
        const showLabel = share >= 0.12;
        return (
          <div
            key={s.label}
            title={`${s.label} — ${s.value} sold${s.detail ? ` · ${s.detail}` : ''} (${pct}%)`}
            style={{
              flex: `${share} 0 0%`,
              minWidth: 3,
              background: s.color,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              paddingLeft: showLabel ? 8 : 0,
            }}
          >
            {showLabel && (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap' }}>
                {pct}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
