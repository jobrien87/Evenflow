// One-time, idempotent, platform-wide backfill for leads that reached
// status SOLD with no real Closed Sale ever logged for them — the exact
// same gap GET /leads/sold-missing-sale surfaces per-agency for a human to
// work through the "LOG ALL" queue, except that queue still requires a
// human to pick a real carrier/policyType per lead. This runs
// automatically (see index.js) and closes the backlog without waiting on
// anyone, using every real value already captured on the Lead and only
// ever substituting the literal string 'Unknown' for carrier/policyType
// when neither is available anywhere (confirmed decision — never the
// dollar amount, which always stays real or null, same as every other
// Billboard/Financials fix this session already relies on).
//
// Idempotent by construction: it only ever selects leads that still have
// no linked, non-voided Sale, so a redundant run (every server boot,
// same convention as index.js's other startup checks) finds nothing left
// to do once the backlog is closed.
const { prisma } = require('./db');
const { createSaleRecord } = require('./saleRecords');
const { PRODUCTS } = require('./products');

const UNKNOWN = 'Unknown';

function resolveProductFamily(lead) {
  const soldQuotes = (lead.productQuotes || []).filter((q) => q.status === 'SOLD');
  if (soldQuotes.length === 1 && PRODUCTS.includes(soldQuotes[0].product)) {
    return soldQuotes[0].product;
  }
  if (lead.saleProduct && PRODUCTS.includes(lead.saleProduct)) {
    return lead.saleProduct;
  }
  return UNKNOWN;
}

// agencyId is optional — omitted (the real index.js call) runs platform-
// wide; passed (test-only) scopes the run to one agency, so an automated
// test can exercise this against its own fixture without touching any
// other test file's in-flight SOLD leads in the same shared CI database.
async function backfillMissingSales({ agencyId } = {}) {
  const soldLeads = await prisma.lead.findMany({
    where: { status: 'SOLD', ...(agencyId ? { agencyId } : {}) },
    include: {
      customer: { select: { firstName: true, lastName: true, zip: true, state: true } },
      productQuotes: { select: { product: true, status: true } },
    },
  });
  if (soldLeads.length === 0) {
    console.log('[missingSaleBackfill] no SOLD leads found, nothing to do');
    return { backfilled: 0, skipped: 0 };
  }

  const linkedSales = await prisma.sale.findMany({
    where: { leadId: { in: soldLeads.map((l) => l.id) }, voidedAt: null },
    select: { leadId: true },
  });
  const linkedLeadIds = new Set(linkedSales.map((s) => s.leadId));
  const missing = soldLeads.filter((l) => !linkedLeadIds.has(l.id));

  if (missing.length === 0) {
    console.log('[missingSaleBackfill] every SOLD lead already has a Closed Sale, nothing to do');
    return { backfilled: 0, skipped: 0 };
  }

  let backfilled = 0;
  const skipped = [];

  for (const lead of missing) {
    if (!lead.customerId || !lead.assignedToId) {
      skipped.push({ leadId: lead.id, reason: !lead.customerId ? 'no customerId' : 'no assignedToId' });
      continue;
    }
    try {
      await createSaleRecord({
        agencyId: lead.agencyId,
        customerId: lead.customerId,
        leadId: lead.id,
        firstName: lead.customer?.firstName || '',
        lastName: lead.customer?.lastName || '',
        zip: lead.zip || lead.customer?.zip,
        state: lead.state || lead.customer?.state,
        saleDate: lead.updatedAt,
        carrier: lead.saleCarrier || UNKNOWN,
        policyType: lead.salePolicyTypeDetail || UNKNOWN,
        productFamily: resolveProductFamily(lead),
        premiumCents: lead.salePremiumCents != null ? lead.salePremiumCents : null,
        assignedToId: lead.assignedToId,
        createdById: lead.assignedToId,
        clientRequestId: `backfill-${lead.id}`,
        actorId: lead.assignedToId,
        actorRole: 'SYSTEM',
        auditAction: 'sale.backfilled',
        notes: 'Backfilled automatically — this lead reached SOLD with no Closed Sale ever logged for it.',
      });
      backfilled += 1;
    } catch (err) {
      skipped.push({ leadId: lead.id, reason: err.message });
    }
  }

  console.log(`[missingSaleBackfill] backfilled ${backfilled} of ${missing.length} missing sale(s)${skipped.length ? `, skipped ${skipped.length}` : ''}`);
  if (skipped.length > 0) {
    console.error('[missingSaleBackfill] skipped leads:', skipped);
  }

  return { backfilled, skipped: skipped.length };
}

module.exports = { backfillMissingSales };
