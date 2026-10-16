// Shared dollar formatter for cents-based amounts — hoisted out of
// BillboardPanel.jsx so the ui/TrendChart.jsx primitive (which must not
// import from pages/) can use the exact same formatting.
export const money = (cents) => `$${((cents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// cents -> a plain dollar string suitable for an <input> value, e.g.
// 15000 -> "150.00". Every form that edits a *Cents field should use this
// pair (dollarsToCents below is the inverse) instead of reinventing the
// same one-liner inline — money() above is read-only display formatting
// (commas, a $ prefix) and isn't meant to round-trip back into an input.
export const centsToDollarInput = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));

// A dollar string from an <input> (e.g. "150", "150.00", "") -> integer
// cents, or null for an empty/invalid value — never NaN leaking into a
// payload.
export const dollarsToCents = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
