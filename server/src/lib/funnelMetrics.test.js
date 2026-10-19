// Real-database integration test — confirms the speed-to-first-attempt
// sample excludes non-vendor-API leads, contactRate/quoteRate/closeRate
// include every real-time lead regardless of intake source, and every
// rate excludes a bulk/Back Catalog import batch row entirely (backfill
// data, not real-time CRM work — see computeFunnel's own comment).
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

  // Manual (no vendorId) lead with an identical fast first attempt — must
  // be EXCLUDED from the speed sample, but still counted toward
  // contactRate (ordinary real-time CRM activity, just not vendor-API).
  await makeLead({ vendorId: null, source: 'manual', assignedAt, firstAttemptAt: fastAttemptAt, firstContactAt: fastAttemptAt });
});

let batchId;

before(async () => {
  const uploader = await prisma.user.create({
    data: { agencyId, email: `funnel-uploader-${suffix}@test.local`, passwordHash: 'x', firstName: 'Up', lastName: 'Loader', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: uploader.id, totalRows: 1, created: 1, skipped: 0 },
  });
  batchId = batch.id;

  const assignedAt = new Date('2026-01-01T00:00:00Z');
  const customer = await prisma.customer.create({ data: { firstName: 'Bulk', lastName: 'Upload' } });
  // A real bulk-imported row, even one that was round-robin-assigned and
  // contacted/quoted/sold for real (none of that should matter) — it must
  // never count toward any rate below, the whole point of this fixture.
  await prisma.lead.create({
    data: {
      agencyId, customerId: customer.id, status: 'SOLD', source: 'bulk_upload', importBatchId: batchId,
      assignedAt, firstContactAt: assignedAt, receivedAt: assignedAt,
    },
  });
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.leadImportBatch.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.agency.deleteMany({ where: { id: agencyId } });
});

test('computeFunnel: speed-to-first-attempt sample excludes non-vendor leads; contactRate includes both real-time leads but never the bulk-imported one', async () => {
  const result = await computeFunnel({
    agencyId,
    from: new Date('2025-12-31T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  });

  // 2, not 3 — the bulk-imported SOLD/contacted row from the fixture above
  // must never appear in totalLeads despite being in range and otherwise
  // indistinguishable (contacted, quoted-or-beyond, sold) from a real lead.
  assert.equal(result.totalLeads, 2, 'the bulk-imported lead must be excluded from every rate, only the 2 real-time leads count');
  assert.equal(result.speedToFirstAttemptSampleSize, 1, 'only the real vendor-API lead counts toward the speed sample');
  assert.equal(result.contactRateSampleSize, 2, 'contactRate denominator includes both real-time leads regardless of intake source, but not the bulk import');
  assert.equal(result.contactRate, 100, 'both real-time leads were contacted, so contactRate is 100% — the bulk-imported SOLD lead never dilutes or inflates it');
  assert.equal(result.closeRate, 0, 'the bulk-imported SOLD lead must not count toward closeRate either — closeRate is 0 since neither real-time lead was sold');
});
