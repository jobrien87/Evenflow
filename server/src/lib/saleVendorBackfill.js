// One-time, idempotent, platform-wide backfill: a Sale linked to a real
// Lead that has its own vendorId, but whose own Sale.vendorId was never
// set (every Sale created before the Sale.vendorId column existed), gets
// its Lead's vendorId copied onto it directly. Runs automatically on
// every boot (see index.js), same "redundant run just confirms
// already-done and no-ops" convention as missingSaleBackfill.js.
//
// This only ever fills in a null using a value the app already treats as
// this exact sale's real vendor at read time — saleLeadLikeRows/
// salesByVendor (lib/manualSaleAggregates.js) already fall back to
// Lead.vendorId whenever Sale.vendorId is null, so this changes nothing
// about what any report has ever shown. It just makes that same answer a
// real, directly-queryable column instead of a join-time fallback, so it
// stays correct even if the Lead is later archived or its vendor
// reassigned. Never touches a Sale that already has its own explicit
// vendorId (set on the Add Closed Sale form, or by a prior run of this
// backfill), and never guesses a vendor for a fully standalone sale with
// no Lead at all — that genuinely has no vendor signal anywhere to
// recover; see server/scripts/report-sale-items-mismatch.js for this
// codebase's convention of surfacing that kind of gap for a human to fix
// by hand rather than fabricating an answer.
const { prisma } = require('./db');
const { recordAudit } = require('./audit');

// agencyId is optional — omitted (the real index.js call) runs platform-
// wide; passed (test-only) scopes the run to one agency, same convention
// backfillMissingSales uses.
async function backfillSaleVendorFromLead({ agencyId } = {}) {
  const candidates = await prisma.sale.findMany({
    where: {
      vendorId: null,
      voidedAt: null,
      leadId: { not: null },
      lead: { is: { vendorId: { not: null } } },
      ...(agencyId ? { agencyId } : {}),
    },
    select: { id: true, agencyId: true, lead: { select: { vendorId: true } } },
  });

  if (candidates.length === 0) {
    console.log('[saleVendorBackfill] no sales need a vendor backfilled, nothing to do');
    return { backfilled: 0 };
  }

  let backfilled = 0;
  for (const sale of candidates) {
    const vendorId = sale.lead.vendorId;
    await prisma.sale.update({ where: { id: sale.id }, data: { vendorId } });
    await recordAudit({
      actorRole: 'SYSTEM',
      agencyId: sale.agencyId,
      action: 'sale.vendorBackfilled',
      entityType: 'Sale',
      entityId: sale.id,
      before: { vendorId: null },
      after: { vendorId },
    });
    backfilled += 1;
  }

  console.log(`[saleVendorBackfill] backfilled vendorId on ${backfilled} sale(s) from their linked lead`);
  return { backfilled };
}

module.exports = { backfillSaleVendorFromLead };
