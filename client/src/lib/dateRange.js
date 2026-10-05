// Resolves a period selector's `periodKey` (one of a page's own preset
// keys, or the literal 'custom') into a concrete {from, to} ISO range.
// Shared by every page using <DateRangeFilter> so the "custom range is
// inclusive of its last day" math lives in exactly one place instead of
// being reimplemented per page.
//
// Returns null when 'custom' is selected but one or both dates aren't
// filled in yet — callers should fall back to sending no from/to at all
// (every backend route here already defaults sensibly on its own), never
// fetch with a half-complete range.
export function resolveDateRange(periodKey, presets, customFrom, customTo) {
  if (periodKey === 'custom') {
    if (!customFrom || !customTo) return null;
    return {
      from: new Date(`${customFrom}T00:00:00.000Z`).toISOString(),
      to: new Date(`${customTo}T23:59:59.999Z`).toISOString(),
    };
  }
  const preset = presets.find((p) => p.key === periodKey);
  if (!preset) return null;
  return {
    from: preset.from().toISOString(),
    to: new Date().toISOString(),
  };
}
