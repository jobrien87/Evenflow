// Reusable period selector: whatever preset buttons a page already shows
// (Day/Week/Month/Year, or "This month"/"This quarter"/...), plus one more
// "CUSTOM" button that reveals a real start/end date pair. Every page still
// owns resolving `periodKey` (or the literal string 'custom') into an
// actual from/to range — this component only owns the UI state for which
// preset (or custom range) is currently picked, so it drops into any
// existing period-selector row without changing that page's data-fetching
// logic.
export default function DateRangeFilter({ presets, periodKey, onSelectPreset, customFrom, customTo, onCustomFromChange, onCustomToChange }) {
  const isCustom = periodKey === 'custom';
  return (
    <div style={s.wrap}>
      <div style={s.row}>
        {presets.map((p) => (
          <button key={p.key} style={periodKey === p.key ? s.btnActive : s.btn} onClick={() => onSelectPreset(p.key)}>
            {p.label}
          </button>
        ))}
        <button style={isCustom ? s.btnActive : s.btn} onClick={() => onSelectPreset('custom')}>CUSTOM</button>
      </div>
      {isCustom && (
        <div style={s.customRow}>
          <input
            type="date"
            style={s.dateInput}
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) => onCustomFromChange(e.target.value)}
          />
          <span style={s.dash}>–</span>
          <input
            type="date"
            style={s.dateInput}
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) => onCustomToChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  btn: {
    padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: 'transparent', color: 'var(--text-secondary)',
  },
  btnActive: {
    padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700,
    background: 'var(--accent-gradient)', color: 'var(--accent-on)',
  },
  customRow: { display: 'flex', alignItems: 'center', gap: 8 },
  dateInput: { padding: '7px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  dash: { color: 'var(--text-muted)', fontSize: 12 },
};
