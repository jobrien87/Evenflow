const { prisma } = require('./db');

// Called when a vendor-sourced lead is created. If the vendor has a
// configured costPerLeadCents, records the real cost event.
async function recordVendorLeadCost(lead, vendor) {
  if (!vendor || !vendor.costPerLeadCents) return null;
  return prisma.costEvent.create({
    data: {
      agencyId: vendor.agencyId,
      vendorId: vendor.id,
      category: 'VENDOR_LEAD_COST',
      amountCents: vendor.costPerLeadCents,
      notes: `Vendor lead cost for lead ${lead.id}`,
    },
  });
}

// Called whenever a standalone Sale (Add Closed Sale) is created,
// corrected, or voided — the one and only production-crediting path. A
// Lead reaching SOLD (whole-lead disposition or a per-product quote) and
// an Opportunity reaching WON are queue/pipeline dispositions only now —
// neither posts revenue directly; an actual closed sale always goes
// through here, counted once, real-money-only (never a fabricated
// commission rate).
//
// Idempotent by design: RevenueEvent.saleId is unique, so this always
// updates/removes the one existing row for a given Sale rather than ever
// creating a second one — what makes a repeated/double-submitted
// correction, or a correction followed by a void, safe against posting
// duplicate credit. `db` may be the global `prisma` client or a `tx`
// transaction client, so this can run standalone (create) or paired
// atomically with the Sale write itself (PATCH, void).
async function syncSaleRevenueEvent(db, sale) {
  if (sale.voidedAt || !sale.premiumCents) {
    await db.revenueEvent.deleteMany({ where: { saleId: sale.id } });
    return null;
  }
  const notes = `Manual closed-sale entry: ${sale.carrier} ${sale.policyType} for ${sale.firstName} ${sale.lastName} (sale ${sale.id})`;
  return db.revenueEvent.upsert({
    where: { saleId: sale.id },
    create: {
      agencyId: sale.agencyId,
      saleId: sale.id,
      category: 'LEAD_REVENUE',
      sourceType: 'SALE',
      amountCents: sale.premiumCents,
      notes,
    },
    update: { amountCents: sale.premiumCents, notes },
  });
}

module.exports = {
  recordVendorLeadCost,
  syncSaleRevenueEvent,
};
