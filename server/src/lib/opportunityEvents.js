const { prisma } = require('./db');
const { detectCrossSellGaps } = require('./crossSellDetection');

async function updateCustomerProductsAndDetectCrossSells({ customerId, agencyId, soldProduct }) {
  if (!customerId || !soldProduct) return [];

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return [];

  const updatedProducts = customer.products.includes(soldProduct)
    ? customer.products
    : [...customer.products, soldProduct];

  await prisma.customer.update({ where: { id: customerId }, data: { products: updatedProducts } });

  const gaps = detectCrossSellGaps(updatedProducts);
  if (gaps.length === 0) return [];

  const existingOpen = await prisma.opportunity.findMany({
    where: { customerId, type: 'CROSS_SELL', status: { notIn: ['DECLINED', 'INELIGIBLE'] } },
    select: { product: true },
  });
  const alreadyOpenProducts = new Set(existingOpen.map((o) => o.product));

  const created = [];
  for (const gap of gaps) {
    if (alreadyOpenProducts.has(gap.suggest)) continue;
    const opp = await prisma.opportunity.create({
      data: {
        agencyId,
        customerId,
        type: 'CROSS_SELL',
        product: gap.suggest,
        reason: gap.reason,
        priorityScore: 40,
      },
    });
    await prisma.opportunityEvent.create({
      data: { opportunityId: opp.id, toStatus: 'OPEN', reason: 'Auto-detected from real product ownership gap' },
    });
    created.push(opp);
  }
  return created;
}

module.exports = { updateCustomerProductsAndDetectCrossSells };
