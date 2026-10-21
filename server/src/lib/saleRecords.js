// The real Sale-creation side-effect sequence — shared by POST /sales (the
// interactive "Add Closed Sale" form) and lib/missingSaleBackfill.js (the
// automatic backfill for leads marked SOLD with no Sale ever logged), so
// both produce an identical, fully real Sale row: the same RevenueEvent
// posting, cross-sell detection, and audit trail, never a thinner
// shortcut. Mirrors createLeadRecord's role in routes/leads.js for the
// exact same reason (single-lead POST + bulk-import both need the one
// real creation path, not two that can drift).
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { syncSaleRevenueEvent } = require('./financialEvents');
const { updateCustomerProductsAndDetectCrossSells } = require('./opportunityEvents');

async function createSaleRecord({
  agencyId, customerId, leadId, firstName, lastName, businessName, customerTitle, customerSuffix,
  zip, state, saleDate, issuedDate, effectiveDate, expirationDate, carrier, policyType, productFamily,
  policyNumber, premiumCents, revenueCents, items, leadSource, priorCarrier, reason, notes, officeId,
  assignedToId, createdById, clientRequestId,
  actorId, actorRole, auditAction, correlationId,
}) {
  const sale = await prisma.sale.create({
    data: {
      agencyId,
      customerId,
      leadId: leadId || null,
      firstName,
      lastName,
      businessName: businessName || null,
      customerTitle: customerTitle || null,
      customerSuffix: customerSuffix || null,
      zip: zip || null,
      state: state || null,
      saleDate,
      issuedDate: issuedDate || null,
      effectiveDate: effectiveDate || null,
      expirationDate: expirationDate || null,
      carrier,
      policyType,
      productFamily,
      policyNumber: policyNumber || null,
      premiumCents: premiumCents != null ? premiumCents : null,
      revenueCents: revenueCents != null ? revenueCents : null,
      items: items != null ? items : 1,
      leadSource: leadSource || null,
      priorCarrier: priorCarrier || null,
      reason: reason || null,
      notes: notes || null,
      officeId: officeId || null,
      assignedToId,
      createdById,
      clientRequestId,
    },
  });

  // Real, entered premium feeds the Financial Ledger — same convention as
  // a Lead's own disposition-to-SOLD path. syncSaleRevenueEvent itself is
  // a no-op when premiumCents is falsy.
  await syncSaleRevenueEvent(prisma, sale);
  // Real sold product updates the customer's product ledger and detects
  // genuine cross-sell gaps — same hook the Lead/Transfer paths already use.
  await updateCustomerProductsAndDetectCrossSells({
    customerId,
    agencyId,
    soldProduct: sale.productFamily,
  });

  await recordAudit({
    actorId: actorId || null,
    actorRole: actorRole || null,
    agencyId,
    action: auditAction || 'sale.created',
    entityType: 'Sale',
    entityId: sale.id,
    after: { carrier: sale.carrier, policyType: sale.policyType, premiumCents: sale.premiumCents, assignedToId },
    correlationId: correlationId || null,
  });

  return sale;
}

module.exports = { createSaleRecord };
