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

// Called when a lead (any source, including a telemarketer submission) is
// dispositioned SOLD with a real entered premium — only real, entered
// numbers, never a fabricated commission rate.
async function recordLeadSaleRevenue(lead) {
  if (!lead.agencyId || !lead.salePremiumCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId: lead.agencyId,
      category: 'LEAD_REVENUE',
      amountCents: lead.salePremiumCents,
      notes: `Sale premium recorded for lead ${lead.id} (${lead.saleProduct || 'product not specified'})`,
    },
  });
}

// Called when a single product on a lead (see LeadProductQuote) is marked
// SOLD with a real entered premium — the per-product analog of
// recordLeadSaleRevenue, since one lead can now sell several products at
// different premiums instead of exactly one.
async function recordLeadProductSaleRevenue({ agencyId, leadId, productLabel, premiumCents }) {
  if (!agencyId || !premiumCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId,
      category: 'LEAD_REVENUE',
      amountCents: premiumCents,
      notes: `Sale premium recorded for lead ${leadId} (${productLabel})`,
    },
  });
}

// Called when a standalone Sale (Add Closed Sale, no originating Lead) is
// created with a real entered premium — same real-money-only convention
// as recordLeadSaleRevenue, just for a sale that never had a Lead row.
async function recordManualSaleRevenue(sale) {
  if (!sale.agencyId || !sale.premiumCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId: sale.agencyId,
      category: 'LEAD_REVENUE',
      amountCents: sale.premiumCents,
      notes: `Manual closed-sale entry: ${sale.carrier} ${sale.policyType} for ${sale.firstName} ${sale.lastName} (sale ${sale.id})`,
    },
  });
}

module.exports = {
  recordVendorLeadCost,
  recordLeadSaleRevenue,
  recordLeadProductSaleRevenue,
  recordManualSaleRevenue,
};
