// Real-database integration test — confirms the speed-to-first-attempt
// sample excludes non-vendor-API leads while contactRate/quoteRate/
// closeRate (ordinary CRM pipeline activity) include every lead
// regardless of source.
//   DATABASE_URL=postgresql://... node --test src/lib/funnelMetrics.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeFunnel } = require('./funnelMetrics');

const suffix = Date.now();
let agencyId;
let vendorId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Funnel Test Agency ${suffix}` } });
  agencyId = agency.id;

  const vendor = await prisma.vendor.create({
    data: { agencyId, name: `Funnel Test Vendor ${suffix}`, email: `funnel-vendor-${suffix}@test.local`, product: 'AUTO' },
  });
  vendorId = vendor.id;

  const assignedAt = new Date('2026-01-01T00:00:00Z');
  const fastAttemptAt = new Date('2026-01-01T00:10:00Z');

  async function makeLead(extra) {
    const customer = await prisma.customer.create({ data: { firstName: 'Funnel', lastName: 'Lead' } });
    // receivedAt defaults to now() — pin it inside the test's query range
    // explicitly so the fixture isn't date-dependent.
    return prisma.lead.create({ data: { agencyId, customerId: customer.id, status: 'NEW', receivedAt: assignedAt, ...extra } });
  }

  // Real vendor-API lead, fast first attempt — must count toward the
  // speed sample.
  await makeLead({ vendorId, assignedAt, firstAttemptAt: fastAttemptAt, firstContactAt: fastAttemptAt });

  // Bulk-upload-style lead (no vendorId) with an identical fast first
  // attempt — must be EXCLUDED from the speed sample, but still counted
  // toward contactRate (ordinary CRM activity).
  await makeLead({ vendorId: null, source: 'manual', assignedAt, firstAttemptAt: fastAttemptAt, firstContactAt: fastAttemptAt });
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.agency.deleteMany({ where: { id: agencyId } });
});

test('computeFunnel: speed-to-first-attempt sample excludes non-vendor leads; contactRate includes both', async () => {
  const result = await computeFunnel({
    agencyId,
    from: new Date('2025-12-31T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  });

  assert.equal(result.totalLeads, 2, 'both leads are in range');
  assert.equal(result.speedToFirstAttemptSampleSize, 1, 'only the real vendor-API lead counts toward the speed sample');
  assert.equal(result.contactRateSampleSize, 2, 'contactRate denominator includes every lead regardless of source');
  assert.equal(result.contactRate, 100, 'both leads were contacted, so contactRate is 100% across all leads');
});
