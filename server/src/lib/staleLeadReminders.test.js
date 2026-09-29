// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query).
// Run with a real DATABASE_URL, same as agencyChat.test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/staleLeadReminders.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { checkStaleLeads, STALE_HOURS } = require('./staleLeadReminders');

const suffix = Date.now();
let agencyId;
let producerId;
let customerId;
let staleLeadId;
let notedLeadId;
let freshLeadId;

const past = new Date(Date.now() - (STALE_HOURS + 1) * 60 * 60 * 1000);

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Test Agency ${suffix}` } });
  agencyId = agency.id;

  const producer = await prisma.user.create({
    data: { email: `producer-stale-${suffix}@test.local`, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId },
  });
  producerId = producer.id;

  const customer = await prisma.customer.create({
    data: { firstName: 'Stale', lastName: 'Lead', phoneNormalized: '5555550100', email: `stale-${suffix}@test.local` },
  });
  customerId = customer.id;

  // Stale: assigned long ago, no note/activity/disposition since.
  const staleLead = await prisma.lead.create({
    data: { agencyId, customerId, status: 'ASSIGNED', assignedToId: producerId, assignedAt: past, receivedAt: past },
  });
  staleLeadId = staleLead.id;

  // Also assigned long ago, but has a recent note — must be skipped.
  const notedLead = await prisma.lead.create({
    data: { agencyId, customerId, status: 'ASSIGNED', assignedToId: producerId, assignedAt: past, receivedAt: past },
  });
  notedLeadId = notedLead.id;
  await prisma.leadNote.create({ data: { leadId: notedLeadId, authorId: producerId, content: 'Left a voicemail.' } });

  // Assigned recently — not old enough to be stale yet.
  const freshLead = await prisma.lead.create({
    data: { agencyId, customerId, status: 'ASSIGNED', assignedToId: producerId },
  });
  freshLeadId = freshLead.id;
});

after(async () => {
  const leadIds = [staleLeadId, notedLeadId, freshLeadId].filter(Boolean);
  // Broad net on userId (not just relatedEntityId) so any notification this
  // test's producer ever received is cleared before the FK-constrained
  // user delete below, regardless of exactly which lead it referenced.
  await prisma.notification.deleteMany({ where: { userId: producerId } });
  if (leadIds.length) {
    await prisma.leadNote.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  }
  if (customerId) await prisma.customer.delete({ where: { id: customerId } });
  if (producerId) await prisma.user.delete({ where: { id: producerId } });
  if (agencyId) await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('checkStaleLeads notifies the assigned producer only for the genuinely stale, unengaged lead', async () => {
  const result = await checkStaleLeads();
  assert.ok(result.reminded >= 1);

  const staleNotification = await prisma.notification.findFirst({ where: { relatedEntityId: staleLeadId, type: 'lead.stale' } });
  assert.ok(staleNotification, 'expected a lead.stale notification for the stale lead');
  assert.equal(staleNotification.userId, producerId);

  const notedNotification = await prisma.notification.findFirst({ where: { relatedEntityId: notedLeadId, type: 'lead.stale' } });
  assert.equal(notedNotification, null, 'a lead with a recent note must not be reminded');

  const freshNotification = await prisma.notification.findFirst({ where: { relatedEntityId: freshLeadId, type: 'lead.stale' } });
  assert.equal(freshNotification, null, 'a recently-assigned lead must not be reminded yet');

  const updatedStaleLead = await prisma.lead.findUnique({ where: { id: staleLeadId } });
  assert.ok(updatedStaleLead.lastReminderSentAt, 'lastReminderSentAt must be set after a reminder is sent');
});

test('checkStaleLeads does not re-notify the same lead again within the staleness window', async () => {
  const before = await prisma.notification.count({ where: { relatedEntityId: staleLeadId, type: 'lead.stale' } });
  await checkStaleLeads();
  const afterCount = await prisma.notification.count({ where: { relatedEntityId: staleLeadId, type: 'lead.stale' } });
  assert.equal(afterCount, before, 'a lead reminded within the window must not be reminded again immediately');
});
