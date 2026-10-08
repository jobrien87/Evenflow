import { useState } from 'react';
import { money } from '../lib/format';

// A real, wider inline dollar-trend chart — replaces BillboardPanel.jsx's
// former page-local TrendLine, promoted to ui/ as a reusable primitive
// (still hand-built SVG, no charting dependency, matching this app's
// established pattern — Sparkline/BarRow/ProgressRing are the same idea).
// Adds a left-margin Y-axis with real dollar gridlines and a hover
// tooltip showing the exact premium + period label for a point — neither
// existed on the old TrendLine.
//
// `series`: [{date, label, soldCount, premiumCents}] — `label` is used
// for both the X-axis tick text and the tooltip's period text, so the
// caller (the server) should make it precise enough for both (e.g.
// "Mon Sep 28" for a week day, "Oct" for a year's month bucket, "2026"
// for an all-years year bucket).
export default function TrendChart({ series, height = 180 }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  if (!series || series.length < 2) return null;

  const leftMargin = 56;
  const bottomMargin = 24;
  const plotWidth = Math.max(series.length * 56, 280);
  const width = plotWidth + leftMargin;
  const plotHeight = height;
  const max = Math.max(...series.map((p) => p.premiumCents), 1);

  const stepX = series.length > 1 ? plotWidth / (series.length - 1) : plotWidth / 2;
  const yFor = (cents) => plotHeight - (cents / max) * (plotHeight - 16);
  const coords = series.map((p, i) => `${leftMargin + i * stepX},${yFor(p.premiumCents)}`).join(' ');

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (max / tickCount) * i);

  const hovered = hoverIndex != null ? series[hoverIndex] : null;
  const hoveredX = hoverIndex != null ? leftMargin + hoverIndex * stepX : 0;
  const hoveredY = hovered ? yFor(hovered.premiumCents) : 0;

  return (
    <div style={{ overflowX: 'auto', position: 'relative' }}>
      <svg width={width} height={plotHeight + bottomMargin}>
        {ticks.map((t, i) => {
          const y = yFor(t);
          return (
            <g key={i}>
              <line x1={leftMargin} y1={y} x2={width} y2={y} stroke="var(--border-hairline)" strokeWidth={1} />
              <text x={leftMargin - 8} y={y + 3} fontSize={10} fill="var(--text-muted)" textAnchor="end">
                {money(t)}
              </text>
            </g>
          );
        })}

        <polyline points={coords} fill="none" stroke="url(#accent-gradient)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

        {series.map((p, i) => {
          const cx = leftMargin + i * stepX;
          const cy = yFor(p.premiumCents);
          return (
            <g key={p.date || i}>
              <circle cx={cx} cy={cy} r={3} fill="var(--accent)" />
              <circle
                cx={cx} cy={cy} r={10} fill="transparent" style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              />
            </g>
          );
        })}

        {series.map((p, i) => (
          i % Math.max(Math.ceil(series.length / 8), 1) === 0 && (
            <text key={`${p.date}-label`} x={leftMargin + i * stepX} y={plotHeight + 18} fontSize={10} fill="var(--text-muted)" textAnchor="middle">
              {p.label || p.date}
            </text>
          )
        ))}
      </svg>

      {hovered && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(hoveredX - 50, 0), width - 110),
            top: Math.max(hoveredY - 48, 0),
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            color: 'var(--text-primary)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ fontWeight: 700 }}>{money(hovered.premiumCents)}</div>
          <div style={{ color: 'var(--text-muted)' }}>{hovered.label || hovered.date}</div>
        </div>
      )}
    </div>
  );
}
