// Real-database test for Create Demo Agency —
//   DATABASE_URL=postgresql... node --test src/lib/demoAgency.test.js
//
// Covers: owner/producers/telemarketers are created directly ACTIVE with a
// working password and zero Invitation rows (no email round-trip at all,
// unlike every other account-creation path); a colliding email aborts
// with no partial writes; TelemarketerAssignment links correctly; demo
// data seeding produces real, fabricated leads/sales that show up on a
// real Billboard computation; and a demo agency with no producers simply
// seeds nothing rather than failing.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');
const { createDemoAgency } = require('./demoAgency');
const { computeBillboard } = require('./billboard');

const suffix = Date.now();
const agencyIdsToClean = [];
const userIdsToClean = [];

after(async () => {
  await prisma.sale.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.auditEvent.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.lead.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.vendor.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.telemarketerAssignment.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.telemarketerProfile.deleteMany({ where: { userId: { in: userIdsToClean } } });
  await prisma.agencySubscription.deleteMany({ where: { agencyId: { in: agencyIdsToClean } } });
  await prisma.user.deleteMany({ where: { id: { in: userIdsToClean } } });
  await prisma.agency.deleteMany({ where: { id: { in: agencyIdsToClean } } });
  await prisma.$disconnect();
});

test('createDemoAgency activates owner/producers/telemarketers directly, with a working password and zero Invitation rows', async () => {
  const result = await createDemoAgency({
    agencyName: `Demo Agency Test ${suffix}`,
    owner: { firstName: 'Demo', lastName: 'Owner', email: `demo-owner-${suffix}@test.local` },
    producers: [
      { firstName: 'Demo', lastName: 'Producer1', email: `demo-producer1-${suffix}@test.local` },
      { firstName: 'Demo', lastName: 'Producer2', email: `demo-producer2-${suffix}@test.local` },
    ],
    telemarketers: [
      { firstName: 'Demo', lastName: 'TM1', email: `demo-tm1-${suffix}@test.local` },
    ],
    password: 'password123',
    seedDemoData: true,
    createdById: null,
  });

  assert.equal(result.success, true);
  agencyIdsToClean.push(result.agency.id);
  userIdsToClean.push(result.owner.id, ...result.producers.map((p) => p.id), ...result.telemarketers.map((t) => t.id));

  assert.equal(result.agency.status, 'ACTIVE');
  assert.equal(result.agency.isDemo, true);

  const ownerRow = await prisma.user.findUnique({ where: { id: result.owner.id } });
  assert.equal(ownerRow.status, 'ACTIVE');
  assert.ok(ownerRow.passwordHash, 'the owner must have a real password hash set directly');
  assert.ok(await bcrypt.compare('password123', ownerRow.passwordHash), 'the given password must actually work');

  for (const p of result.producers) {
    const row = await prisma.user.findUnique({ where: { id: p.id } });
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.agencyId, result.agency.id);
    assert.ok(await bcrypt.compare('password123', row.passwordHash));
  }

  const tmRow = await prisma.user.findUnique({ where: { id: result.telemarketers[0].id } });
  assert.equal(tmRow.status, 'ACTIVE');
  assert.equal(tmRow.agencyId, null, 'a telemarketer User row is never tied to one agency directly');
  const assignment = await prisma.telemarketerAssignment.findFirst({ where: { telemarketerId: tmRow.id, agencyId: result.agency.id } });
  assert.ok(assignment, 'the telemarketer must be assigned to the new demo agency');
  assert.equal(assignment.status, 'ACTIVE');

  const invitations = await prisma.invitation.findMany({ where: { userId: { in: [result.owner.id, ...result.producers.map((p) => p.id), ...result.telemarketers.map((t) => t.id)] } } });
  assert.equal(invitations.length, 0, 'no Invitation row should ever be created for a demo account — nothing is emailed');

  const subscription = await prisma.agencySubscription.findFirst({ where: { agencyId: result.agency.id }, include: { plan: true } });
  assert.equal(subscription.plan.name, 'Full Platform');
  assert.equal(subscription.status, 'ACTIVE');

  assert.ok(result.seeded);
  assert.ok(result.seeded.leadCount > 0);
  assert.ok(result.seeded.saleCount > 0);

  // The fabricated sales must show up on a real Billboard computation,
  // exactly like genuine production data would.
  const billboard = await computeBillboard({ agencyId: result.agency.id, granularity: 'month', from: new Date('2020-01-01'), to: new Date() });
  assert.equal(billboard.totals.soldCount, result.seeded.saleCount);
});

test('createDemoAgency aborts entirely, with no partial writes, when an email in the roster already exists', async () => {
  const collidingEmail = `demo-collision-${suffix}@test.local`;
  const existingUser = await prisma.user.create({
    data: { email: collidingEmail, firstName: 'Already', lastName: 'Exists', role: 'PRODUCER', status: 'ACTIVE' },
  });
  userIdsToClean.push(existingUser.id);

  const before = await prisma.agency.count();
  const result = await createDemoAgency({
    agencyName: `Demo Collision Agency ${suffix}`,
    owner: { firstName: 'Demo', lastName: 'Owner2', email: `demo-owner2-${suffix}@test.local` },
    producers: [{ firstName: 'Taken', lastName: 'Email', email: collidingEmail }],
    telemarketers: [],
    password: 'password123',
    seedDemoData: false,
    createdById: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'EMAIL_IN_USE');
  const after = await prisma.agency.count();
  assert.equal(after, before, 'no agency row must be created when any roster email collides');
  const ownerRow = await prisma.user.findUnique({ where: { email: `demo-owner2-${suffix}@test.local` } });
  assert.equal(ownerRow, null, 'no user row must be created either, since the whole request is rejected up front');
});

test('createDemoAgency with zero producers seeds nothing (no one to assign demo production to), but still activates the owner', async () => {
  const result = await createDemoAgency({
    agencyName: `Demo No-Producers Agency ${suffix}`,
    owner: { firstName: 'Demo', lastName: 'SoloOwner', email: `demo-solo-owner-${suffix}@test.local` },
    producers: [],
    telemarketers: [],
    password: 'password123',
    seedDemoData: true,
    createdById: null,
  });

  assert.equal(result.success, true);
  agencyIdsToClean.push(result.agency.id);
  userIdsToClean.push(result.owner.id);

  assert.equal(result.seeded, null, 'nothing is seeded when there are no producers to assign it to');
  const leadCount = await prisma.lead.count({ where: { agencyId: result.agency.id } });
  assert.equal(leadCount, 0);
});
