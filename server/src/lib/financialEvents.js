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

module.exports = {
  recordVendorLeadCost,
  recordLeadSaleRevenue,
};
