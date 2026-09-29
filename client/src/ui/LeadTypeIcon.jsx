import Icon from './Icon';
import { TONE_COLORS } from './statusTones';
import { LEAD_TYPE_META } from '../lib/leadTypeMeta';

// A small, consistent glyph for a Lead's leadType (Transfer, Paid Ad,
// Direct Mail, Meta Ad, Manual, Winback, Cross-Sell) — dropped next to a
// lead's name anywhere a list of leads mixes more than one source, so a
// user can tell them apart at a glance without reading the status/source
// text. Hover shows the full label via the native title tooltip.
export default function LeadTypeIcon({ type, size = 14, style }) {
  const meta = LEAD_TYPE_META[type];
  if (!meta) return null;
  const tone = TONE_COLORS[meta.tone] || TONE_COLORS.neutral;
  return (
    <span title={meta.label} style={{ display: 'inline-flex', alignItems: 'center', color: tone.fg, flexShrink: 0, ...style }}>
      <Icon name={meta.icon} size={size} />
    </span>
  );
}
