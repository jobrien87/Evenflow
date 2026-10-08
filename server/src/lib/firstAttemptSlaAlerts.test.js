// Real-database integration test — confirms the speed-to-lead SLA check
// only ever fires for real vendor-API leads (Lead.vendorId set), never
// for bulk-upload/manual/telemarketer-sourced leads that happen to sit
// unworked past the same cutoff.
//   DATABASE_URL=postgresql://... node --test src/lib/firstAttemptSlaAlerts.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { checkFirstAttemptSla } = require('./firstAttemptSlaAlerts');

const suffix = Date.now();
let agencyId;
let producerId;
let vendorId;
let vendorLeadId;
let nonVendorLeadId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `SLA Test Agency ${suffix}` } });
  agencyId = agency.id;

  const producer = await prisma.user.create({
    data: { agencyId, email: `sla-producer-${suffix}@test.local`, passwordHash: 'x', firstName: 'Sla', lastName: 'Test', role: 'PRODUCER', status: 'ACTIVE' },
  });
  producerId = producer.id;

  const vendor = await prisma.vendor.create({
    data: { agencyId, name: `SLA Test Vendor ${suffix}`, email: `sla-vendor-${suffix}@test.local`, product: 'AUTO' },
  });
  vendorId = vendor.id;

  const customer1 = await prisma.customer.create({ data: { firstName: 'Vendor', lastName: 'Lead' } });
  const customer2 = await prisma.customer.create({ data: { firstName: 'Bulk', lastName: 'Lead' } });

  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago — well past any SLA_MINUTES cutoff

  // Real vendor-API-sourced lead, past the SLA cutoff, never attempted.
  const vendorLead = await prisma.lead.create({
    data: {
      agencyId, customerId: customer1.id, assignedToId: producerId, status: 'NEW',
      vendorId, assignedAt: longAgo, firstAttemptAt: null, firstAttemptSlaAlertSentAt: null,
    },
  });
  vendorLeadId = vendorLead.id;

  // Bulk-upload/manual-sourced lead (no vendorId), otherwise identical.
  const nonVendorLead = await prisma.lead.create({
    data: {
      agencyId, customerId: customer2.id, assignedToId: producerId, status: 'NEW',
      vendorId: null, source: 'manual', assignedAt: longAgo, firstAttemptAt: null, firstAttemptSlaAlertSentAt: null,
    },
  });
  nonVendorLeadId = nonVendorLead.id;
});

after(async () => {
  await prisma.notification.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.customer.deleteMany({ where: { id: { in: [] } } }); // customers are global; leave them, harmless test fixtures
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.deleteMany({ where: { id: agencyId } });
});

test('checkFirstAttemptSla only alerts the real vendor-API lead, never the non-vendor one', async () => {
  const alertedCount = await checkFirstAttemptSla();
  assert.ok(alertedCount >= 1, 'at least the vendor lead should be alerted');

  const vendorLeadAfter = await prisma.lead.findUnique({ where: { id: vendorLeadId } });
  assert.ok(vendorLeadAfter.firstAttemptSlaAlertSentAt, 'real vendor-API lead must be marked alerted');

  const nonVendorLeadAfter = await prisma.lead.findUnique({ where: { id: nonVendorLeadId } });
  assert.equal(nonVendorLeadAfter.firstAttemptSlaAlertSentAt, null, 'non-vendor lead must never be marked alerted');

  const vendorNotification = await prisma.notification.findFirst({
    where: { userId: producerId, relatedEntityId: vendorLeadId, type: 'lead.first_attempt_overdue' },
  });
  assert.ok(vendorNotification, 'a notification must be created for the vendor lead');

  const nonVendorNotification = await prisma.notification.findFirst({
    where: { userId: producerId, relatedEntityId: nonVendorLeadId, type: 'lead.first_attempt_overdue' },
  });
  assert.equal(nonVendorNotification, null, 'no notification must be created for the non-vendor lead');
});
