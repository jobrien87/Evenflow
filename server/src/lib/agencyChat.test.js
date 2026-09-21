// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query).
// Run with a real DATABASE_URL, same as scripts/smoke-test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/agencyChat.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { agencyChatParticipantIds, getOrSyncAgencyConversation } = require('./agencyChat');

const suffix = Date.now();
let agencyId;
let ownerId;
let producerId;
let tmId;
let assignmentId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Test Agency ${suffix}` } });
  agencyId = agency.id;

  const owner = await prisma.user.create({
    data: { email: `owner-${suffix}@test.local`, firstName: 'Test', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId },
  });
  ownerId = owner.id;

  const producer = await prisma.user.create({
    data: { email: `producer-${suffix}@test.local`, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId },
  });
  producerId = producer.id;

  const tm = await prisma.user.create({
    data: { email: `tm-${suffix}@test.local`, firstName: 'Test', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  tmId = tm.id;

  const assignment = await prisma.telemarketerAssignment.create({
    data: { telemarketerId: tmId, agencyId, status: 'ACTIVE' },
  });
  assignmentId = assignment.id;
});

after(async () => {
  const conversation = await prisma.conversation.findUnique({
    where: { relatedEntityType_relatedEntityId: { relatedEntityType: 'AGENCY', relatedEntityId: agencyId } },
  });
  if (conversation) {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
  await prisma.telemarketerAssignment.deleteMany({ where: { id: assignmentId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, producerId, tmId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('agencyChatParticipantIds includes active agency users and active TM assignments', async () => {
  const ids = await agencyChatParticipantIds(agencyId);
  assert.ok(ids.includes(ownerId), 'expected the agency owner to be a member');
  assert.ok(ids.includes(producerId), 'expected the producer to be a member');
  assert.ok(ids.includes(tmId), 'expected the actively-assigned TM to be a member');
  assert.equal(ids.length, 3);
});

test('getOrSyncAgencyConversation creates one room and adds all real members', async () => {
  const conversation = await getOrSyncAgencyConversation(agencyId);
  assert.equal(conversation.relatedEntityType, 'AGENCY');
  assert.equal(conversation.relatedEntityId, agencyId);
  const memberIds = conversation.participants.map((p) => p.userId);
  assert.ok(memberIds.includes(ownerId));
  assert.ok(memberIds.includes(producerId));
  assert.ok(memberIds.includes(tmId));
});

test('getOrSyncAgencyConversation prunes a deactivated producer and an ended TM assignment on the next call', async () => {
  await prisma.user.update({ where: { id: producerId }, data: { status: 'DEACTIVATED' } });
  await prisma.telemarketerAssignment.update({ where: { id: assignmentId }, data: { status: 'ENDED', effectiveTo: new Date() } });

  const conversation = await getOrSyncAgencyConversation(agencyId);
  const memberIds = conversation.participants.map((p) => p.userId);

  assert.ok(memberIds.includes(ownerId), 'the still-active owner must remain a member');
  assert.ok(!memberIds.includes(producerId), 'a deactivated producer must lose access');
  assert.ok(!memberIds.includes(tmId), 'a TM whose assignment ended must lose access');

  // Restore for a clean re-run / other tests in this file.
  await prisma.user.update({ where: { id: producerId }, data: { status: 'ACTIVE' } });
  await prisma.telemarketerAssignment.update({ where: { id: assignmentId }, data: { status: 'ACTIVE', effectiveTo: null } });
});
