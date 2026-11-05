// Categorical chart-series palette for a product/policy-type breakdown —
// validated (CVD-safe, contrast-checked against this app's dark card
// surface) via the dataviz skill's scripts/validate_palette.js. Colors are
// assigned in a FIXED order, by this app's own canonical product catalog
// order (PRODUCTS, from productMeta.js) — never "first seen in this
// dataset" — so a given product always gets the same color on every chart,
// every load (color follows the entity, never its rank). Products past the
// 8th slot fold into a shared neutral "Other" bucket rather than minting a
// 9th hue, per the dataviz skill's categorical-palette rule.
import { PRODUCTS, PRODUCT_META } from './productMeta';

const SLOT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#6b6f76';

const PRODUCT_COLOR_BY_LABEL = {};
PRODUCTS.slice(0, SLOT_COLORS.length).forEach((code, i) => {
  PRODUCT_COLOR_BY_LABEL[PRODUCT_META[code].label] = SLOT_COLORS[i];
});

export function productColor(label) {
  return PRODUCT_COLOR_BY_LABEL[label] || OTHER_COLOR;
}

export function isFoldedToOther(label) {
  return !PRODUCT_COLOR_BY_LABEL[label];
}

// Legend entries in fixed catalog order, limited to products that actually
// appear in `labelsPresent` — never the full 14-product catalog when only
// a few are in use this period. Every folded (9th+) product collapses to
// one trailing "Other" entry.
export function productLegendEntries(labelsPresent) {
  const present = new Set(labelsPresent);
  const entries = PRODUCTS.slice(0, SLOT_COLORS.length)
    .map((code) => PRODUCT_META[code].label)
    .filter((label) => present.has(label))
    .map((label) => ({ label, color: productColor(label) }));
  const hasOther = [...present].some((label) => isFoldedToOther(label));
  if (hasOther) entries.push({ label: 'Other', color: OTHER_COLOR });
  return entries;
}
