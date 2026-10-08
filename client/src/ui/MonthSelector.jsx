// A horizontally scrollable row of month chips, for Billboard's Month
// view — hydrates directly from the already-fetched billboard response's
// `availableMonths` (no second request). `selected`/`onSelect` use plain
// {year, month} objects, matching the server's own shape.
export default function MonthSelector({ months = [], selected, onSelect }) {
  if (months.length === 0) return null;
  return (
    <div style={s.row}>
      {months.map((m) => {
        const active = selected && selected.year === m.year && selected.month === m.month;
        return (
          <button
            key={`${m.year}-${m.month}`}
            type="button"
            onClick={() => onSelect({ year: m.year, month: m.month })}
            style={{ ...s.chip, ...(active ? s.chipActive : {}) }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

const s = {
  row: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    padding: '4px 0 10px',
    marginBottom: 6,
  },
  chip: {
    flexShrink: 0,
    padding: '6px 14px',
    borderRadius: 999,
    border: '1px solid var(--border-hairline)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  chipActive: {
    border: '1px solid var(--border-accent)',
    background: 'var(--accent-gradient-soft)',
    color: 'var(--accent)',
  },
};
