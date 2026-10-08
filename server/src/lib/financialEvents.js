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

// Called when a standalone Sale (Add Closed Sale) is created with a real
// entered premium — the one and only production-crediting path. A Lead
// reaching SOLD (whole-lead disposition or a per-product quote) and an
// Opportunity reaching WON are queue/pipeline dispositions only now —
// neither posts revenue directly; an actual closed sale always goes
// through here, counted once, real-money-only (never a fabricated
// commission rate).
async function recordManualSaleRevenue(sale) {
  if (!sale.agencyId || !sale.premiumCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId: sale.agencyId,
      category: 'LEAD_REVENUE',
      sourceType: 'SALE',
      amountCents: sale.premiumCents,
      notes: `Manual closed-sale entry: ${sale.carrier} ${sale.policyType} for ${sale.firstName} ${sale.lastName} (sale ${sale.id})`,
    },
  });
}

module.exports = {
  recordVendorLeadCost,
  recordManualSaleRevenue,
};
