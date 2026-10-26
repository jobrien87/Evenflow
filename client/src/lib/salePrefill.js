import { PRODUCTS } from './productMeta';

// Lead disposition-to-SOLD (whole-lead or per-product) is a queue/pipeline
// status only now — it posts no revenue. Pre-fills what's actually real
// and already on the Lead (customer contact info, premium/product only
// when exactly one product was sold, so nothing is guessed), so logging
// the real production entry is one click away instead of a silent gap.
// Shared by every surface that can disposition a lead to SOLD
// (LeadDetailModal, YieldTransfersPanel, ProducerDashboard) so each one's
// mandatory Sale-log gate prefills the exact same way.
export function buildSalePrefillFromLead(lead) {
  const c = lead.customer || {};
  const soldQuotes = (lead.productQuotes || []).filter((q) => q.status === 'SOLD');
  const singleSoldProduct = soldQuotes.length === 1 ? soldQuotes[0].product : undefined;
  return {
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    phone: c.phoneNormalized || '',
    email: c.email || '',
    zip: lead.zip || c.zip || '',
    state: lead.state || c.state || '',
    ...(singleSoldProduct && PRODUCTS.includes(singleSoldProduct) ? { productFamily: singleSoldProduct } : {}),
    ...(soldQuotes.length > 0 ? { items: String(soldQuotes.length) } : {}),
    premiumCents: lead.salePremiumCents != null ? (lead.salePremiumCents / 100).toFixed(2) : '',
    assignedToId: lead.assignedToId || '',
  };
}
