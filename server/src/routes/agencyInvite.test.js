// Real-DB, real-HTTP tests for POST /agencies's invite-time billing/
// entitlement setup (seat price, comp flag, module checkboxes) — mirrors
// invitationEmailStatus.test.js's conventions (real http server,
// createSession cookie, no Brevo key so email always degrades to
// NOT_CONFIGURED, which is fine since these tests only assert on the
// created Agency/Plan/AgencySubscription rows, not email delivery).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let platformOwnerId, platformOwnerCookie;
let server, baseUrl;
const createdAgencyIds = [];
const createdUserEmails = [];

before(async () => {
  const platformOwner = await prisma.user.create({
    data: {
      email: `agyinvite-po-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12),
      firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE',
    },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  try {
    await prisma.agencySubscription.deleteMany({ where: { agencyId: { in: createdAgencyIds } } });
    await prisma.plan.deleteMany({ where: { name: 'Comped' } });
    await prisma.plan.deleteMany({ where: { name: { contains: 'Custom Seat Plan' } } });
    await prisma.invitation.deleteMany({ where: { agencyId: { in: createdAgencyIds } } });
    await prisma.session.deleteMany({ where: { user: { email: { in: createdUserEmails } } } });
    await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
    await prisma.agency.deleteMany({ where: { id: { in: createdAgencyIds } } });
    await prisma.session.deleteMany({ where: { userId: platformOwnerId } });
    await prisma.user.delete({ where: { id: platformOwnerId } }).catch(() => {});
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});

async function createAgency(body) {
  const res = await fetch(`${baseUrl}/api/agencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.success && data.agency?.id) {
    createdAgencyIds.push(data.agency.id);
    createdUserEmails.push(body.ownerEmail.toLowerCase());
  }
  return { status: res.status, data };
}

test('plain invite (no billing/entitlement fields) creates no subscription and leaves every entitlement at the schema default', async () => {
  const { status, data } = await createAgency({
    name: `Plain Invite Agency ${suffix}`,
    ownerFirstName: 'Plain',
    ownerLastName: 'Owner',
    ownerEmail: `agyinvite-plain-${suffix}@test.local`,
  });
  assert.equal(status, 201);
  assert.equal(data.subscription, null);
  assert.equal(data.agency.crmEnabled, true);
  assert.equal(data.agency.transfersEnabled, false);
  assert.equal(data.agency.coachingEnabled, false);
  assert.equal(data.agency.salesStudioGateEnabled, true);
  assert.equal(data.agency.breakRoomEnabled, true);
  assert.equal(data.agency.hrEnabled, true);

  const subCount = await prisma.agencySubscription.count({ where: { agencyId: data.agency.id } });
  assert.equal(subCount, 0);
});

test('isComped: true creates (or reuses) a shared zero-price Comped plan and an ACTIVE subscription', async () => {
  const { status, data } = await createAgency({
    name: `Comped Agency ${suffix}`,
    ownerFirstName: 'Comp',
    ownerLastName: 'Owner',
    ownerEmail: `agyinvite-comped-${suffix}@test.local`,
    isComped: true,
  });
  assert.equal(status, 201);
  assert.ok(data.subscription);
  assert.equal(data.subscription.status, 'ACTIVE');
  assert.equal(data.subscription.agencyId, data.agency.id);

  const plan = await prisma.plan.findUnique({ where: { id: data.subscription.planId } });
  assert.equal(plan.name, 'Comped');
  assert.equal(plan.priceCents, 0);
  assert.equal(plan.perSeat, false);

  // A second comped invite reuses the same Plan row rather than creating
  // a duplicate — Plan.name has no unique constraint, so this is the real
  // guarantee the find-then-create logic has to hold.
  const { data: second } = await createAgency({
    name: `Comped Agency Two ${suffix}`,
    ownerFirstName: 'Comp',
    ownerLastName: 'OwnerTwo',
    ownerEmail: `agyinvite-comped2-${suffix}@test.local`,
    isComped: true,
  });
  const secondPlan = await prisma.plan.findUnique({ where: { id: second.subscription.planId } });
  assert.equal(secondPlan.id, plan.id);
  const compedPlanCount = await prisma.plan.count({ where: { name: 'Comped' } });
  assert.equal(compedPlanCount, 1);
});

test('seatPriceCents creates a dedicated per-seat Plan at that price and an ACTIVE subscription', async () => {
  const { status, data } = await createAgency({
    name: `Custom Seat Agency ${suffix}`,
    ownerFirstName: 'Custom',
    ownerLastName: 'Owner',
    ownerEmail: `agyinvite-customseat-${suffix}@test.local`,
    seatPriceCents: 2500,
  });
  assert.equal(status, 201);
  assert.ok(data.subscription);
  assert.equal(data.subscription.status, 'ACTIVE');

  const plan = await prisma.plan.findUnique({ where: { id: data.subscription.planId } });
  assert.equal(plan.priceCents, 2500);
  assert.equal(plan.perSeat, true);
  assert.ok(plan.name.includes('Custom Seat Plan'));
});

test('isComped takes precedence over a seatPriceCents given alongside it', async () => {
  const { status, data } = await createAgency({
    name: `Comped Precedence Agency ${suffix}`,
    ownerFirstName: 'Precedence',
    ownerLastName: 'Owner',
    ownerEmail: `agyinvite-precedence-${suffix}@test.local`,
    isComped: true,
    seatPriceCents: 9900,
  });
  assert.equal(status, 201);
  const plan = await prisma.plan.findUnique({ where: { id: data.subscription.planId } });
  assert.equal(plan.name, 'Comped');
  assert.equal(plan.priceCents, 0);
});

test('entitlement checkboxes are merged into the created Agency row', async () => {
  const { status, data } = await createAgency({
    name: `Entitlement Agency ${suffix}`,
    ownerFirstName: 'Mod',
    ownerLastName: 'Owner',
    ownerEmail: `agyinvite-entitlements-${suffix}@test.local`,
    hrEnabled: false,
    breakRoomEnabled: false,
    coachingEnabled: true,
  });
  assert.equal(status, 201);
  assert.equal(data.agency.hrEnabled, false);
  assert.equal(data.agency.breakRoomEnabled, false);
  assert.equal(data.agency.coachingEnabled, true);
  // Untouched fields keep the schema default.
  assert.equal(data.agency.crmEnabled, true);
  assert.equal(data.agency.transfersEnabled, false);
  assert.equal(data.agency.salesStudioGateEnabled, true);
});

test('a non-Platform-Owner cannot create an agency', async () => {
  const agency = await prisma.agency.create({ data: { name: `Non-PO Caller Agency ${suffix}` } });
  createdAgencyIds.push(agency.id);
  const owner = await prisma.user.create({
    data: {
      email: `agyinvite-nonpo-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12),
      firstName: 'Non', lastName: 'PO', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: agency.id,
    },
  });
  createdUserEmails.push(owner.email);
  const cookie = `evenflow_session=${(await createSession(owner.id)).rawToken}`;
  const res = await fetch(`${baseUrl}/api/agencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: `Should Not Be Created ${suffix}`,
      ownerFirstName: 'No', ownerLastName: 'Way', ownerEmail: `agyinvite-blocked-${suffix}@test.local`,
    }),
  });
  assert.equal(res.status, 403);
});
