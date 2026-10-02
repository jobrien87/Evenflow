// Real-database integration test for isLastActiveOwner (see agencyChat.test.js
// for the same real-DB-over-mocked-Prisma convention this app uses). Run
// with a real DATABASE_URL:
//   DATABASE_URL=postgresql://... node --test src/routes/users.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../lib/db');
const { isLastActiveOwner } = require('./users');

const suffix = Date.now();
let agencyId;
let ownerId;
let secondOwnerId;
let managerId;
let platformOwnerId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Last-Owner Test Agency ${suffix}` } });
  agencyId = agency.id;

  const owner = await prisma.user.create({
    data: { email: `last-owner-${suffix}@test.local`, firstName: 'Sole', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId },
  });
  ownerId = owner.id;

  const manager = await prisma.user.create({
    data: { email: `last-owner-manager-${suffix}@test.local`, firstName: 'Some', lastName: 'Manager', role: 'AGENCY_MANAGER', status: 'ACTIVE', agencyId },
  });
  managerId = manager.id;

  // A single synthetic PLATFORM_OWNER used only to prove the function
  // treats an inactive platform owner as not counting — never asserts
  // anything about the real platform-wide count, since this DB may
  // already hold real platform owners outside this test's control.
  const platformOwner = await prisma.user.create({
    data: { email: `last-owner-po-${suffix}@test.local`, firstName: 'Synthetic', lastName: 'PlatformOwner', role: 'PLATFORM_OWNER', status: 'DEACTIVATED' },
  });
  platformOwnerId = platformOwner.id;
});

after(async () => {
  const ids = [ownerId, secondOwnerId, managerId, platformOwnerId].filter(Boolean);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('isLastActiveOwner: true for the sole active AGENCY_OWNER of an agency', async () => {
  const target = await prisma.user.findUnique({ where: { id: ownerId } });
  assert.equal(await isLastActiveOwner(target), true);
});

test('isLastActiveOwner: false once a second active AGENCY_OWNER exists in the same agency', async () => {
  const second = await prisma.user.create({
    data: { email: `second-owner-${suffix}@test.local`, firstName: 'Second', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId },
  });
  secondOwnerId = second.id;
  const target = await prisma.user.findUnique({ where: { id: ownerId } });
  assert.equal(await isLastActiveOwner(target), false);
  // Deactivate the second owner again so the sole-owner assertion above
  // stays true if tests ever run more than once against the same fixture.
  await prisma.user.update({ where: { id: secondOwnerId }, data: { status: 'DEACTIVATED' } });
});

test('isLastActiveOwner: false for a non-owner role (AGENCY_MANAGER) regardless of count', async () => {
  const target = await prisma.user.findUnique({ where: { id: managerId } });
  assert.equal(await isLastActiveOwner(target), false);
});

test('isLastActiveOwner: false for a target that is already DEACTIVATED (nothing to lock out)', async () => {
  const target = await prisma.user.findUnique({ where: { id: platformOwnerId } });
  assert.equal(await isLastActiveOwner(target), false);
});
