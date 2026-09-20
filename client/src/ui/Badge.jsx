import { TONE_COLORS } from './statusTones';

export default function Badge({ tone = 'neutral', children, style }) {
  const c = TONE_COLORS[tone] || TONE_COLORS.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        padding: '4px 10px',
        borderRadius: 999,
        color: c.fg,
        border: `1px solid ${c.border}`,
        background: c.bg,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
