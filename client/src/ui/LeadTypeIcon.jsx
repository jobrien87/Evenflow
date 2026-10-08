import Icon from './Icon';
import { TONE_COLORS } from './statusTones';
import { LEAD_TYPE_META } from '../lib/leadTypeMeta';
import { PRODUCT_META } from '../lib/productMeta';

// A small, consistent glyph for a Lead's leadType (Transfer, Paid Ad,
// Direct Mail, Meta Ad, Manual, Winback, Cross-Sell) — dropped next to a
// lead's name anywhere a list of leads mixes more than one source, so a
// user can tell them apart at a glance without reading the status/source
// text. Hover shows the full label via the native title tooltip.
//
// `product`/`crossSellHaveProduct` are optional — when a Cross-Sell lead
// carries a specific have/need pair (set by the AUTO_NO_HOME/HOME_NO_AUTO
// bulk-upload categories), this renders a combo icon instead: the
// available-to-quote product's own icon, with a small bidirectional
// "exchange" badge in the corner, so the opportunity reads at a glance
// without opening the lead. Any other leadType, or a plain Cross-Sell
// lead with no specific pair, falls through to the single-icon default.
export default function LeadTypeIcon({ type, product, crossSellHaveProduct, size = 14, style }) {
  const meta = LEAD_TYPE_META[type];
  if (!meta) return null;
  const tone = TONE_COLORS[meta.tone] || TONE_COLORS.neutral;

  if (type === 'CROSS_SELL' && crossSellHaveProduct) {
    const needCode = product ? product.toUpperCase() : null;
    const needMeta = needCode && PRODUCT_META[needCode];
    const haveMeta = PRODUCT_META[crossSellHaveProduct];
    if (needMeta) {
      const title = `Cross-Sell — ${needMeta.label}${haveMeta ? ` (has ${haveMeta.label})` : ''}`;
      return (
        <span title={title} style={{ display: 'inline-flex', alignItems: 'center', position: 'relative', color: tone.fg, flexShrink: 0, ...style }}>
          <Icon name={needMeta.icon} size={size} />
          <span style={{ position: 'absolute', right: -4, bottom: -4, color: 'var(--accent)', background: 'var(--bg-elevated)', borderRadius: '50%', display: 'inline-flex', padding: 1 }}>
            <Icon name="exchange" size={Math.round(size * 0.6)} />
          </span>
        </span>
      );
    }
  }

  return (
    <span title={meta.label} style={{ display: 'inline-flex', alignItems: 'center', color: tone.fg, flexShrink: 0, ...style }}>
      <Icon name={meta.icon} size={size} />
    </span>
  );
}
