// Shared dollar formatter for cents-based amounts — hoisted out of
// BillboardPanel.jsx so the ui/TrendChart.jsx primitive (which must not
// import from pages/) can use the exact same formatting.
export const money = (cents) => `$${((cents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
