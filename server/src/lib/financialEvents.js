const { prisma } = require('./db');

// Called when a transfer is accepted. If the agency has configured a
// transferFeeCents, records the real revenue event. If not configured,
// does nothing — no fabricated fee is invented.
async function recordTransferAcceptedRevenue(transfer, agency) {
  if (!agency || !agency.transferFeeCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId: agency.id,
      transferId: transfer.id,
      category: 'TRANSFER_REVENUE',
      amountCents: agency.transferFeeCents,
      notes: `Transfer fee for accepted transfer ${transfer.id}`,
    },
  });
}

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

// Called when a credit request is approved — the transfer fee revenue is
// offset by a matching CREDIT cost event, rather than editing/deleting the
// original revenue event (append-only financial history).
async function recordCreditApproved(transfer, creditRequest, agency) {
  if (!agency || !agency.transferFeeCents) return null;
  return prisma.costEvent.create({
    data: {
      agencyId: agency.id,
      transferId: transfer.id,
      category: 'CREDIT',
      amountCents: agency.transferFeeCents,
      notes: `Credit approved for transfer ${transfer.id} (credit request ${creditRequest.id})`,
    },
  });
}

// Called when a Transfer is dispositioned SOLD with a real entered premium.
// Unlike the flat per-transfer acceptance fee, this uses the actual dollar
// amount the producer entered — real data, not a fabricated rate.
async function recordTransferSaleRevenue(transfer) {
  if (!transfer.agencyId || !transfer.salePremiumCents) return null;
  return prisma.revenueEvent.create({
    data: {
      agencyId: transfer.agencyId,
      transferId: transfer.id,
      category: 'LEAD_REVENUE',
      amountCents: transfer.salePremiumCents,
      notes: `Sale premium recorded for transfer ${transfer.id} (${transfer.saleProduct || 'product not specified'})`,
    },
  });
}

// Called when a CRM Lead (not a Yield Transfer) is dispositioned SOLD with a
// real entered premium — the direct/vendor-sourced-lead equivalent of the
// transfer sale hook above. Same principle: only real, entered numbers.
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
  recordTransferAcceptedRevenue,
  recordVendorLeadCost,
  recordCreditApproved,
  recordTransferSaleRevenue,
  recordLeadSaleRevenue,
};
