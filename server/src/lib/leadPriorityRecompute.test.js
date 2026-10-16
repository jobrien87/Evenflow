// Real-database integration test for leadPriorityRecompute.js — previously
// untested. Covers the one thing this round actually changed: the local
// hardcoded TERMINAL_LEAD_STATUSES const was replaced with the real,
// per-agency Agency.closedLeadStatuses (falling back to
// lib/leadStatusGroups.js's shared default when unconfigured).
//   DATABASE_URL=postgresql://... node --test src/lib/leadPriorityRecompute.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { recomputeAgencyLeadPriority, recomputeAllLeadPriorities, DEFAULT_CLOSED_STATUSES } = require('./leadPriorityRecompute');

const suffix = Date.now();
let agencyId;
let customerId;
let activeLeadId;
let soldLeadId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Priority Recompute Agency ${suffix}` } });
  agencyId = agency.id;

  const customer = await prisma.customer.create({ data: { firstName: 'Recompute', lastName: 'Test' } });
  customerId = customer.id;

  const activeLead = await prisma.lead.create({
    data: { agencyId, customerId, status: 'NEW', priorityScore: 0 },
  });
  activeLeadId = activeLead.id;

  // SOLD is in the default closed-status list — must never be recomputed.
  const soldLead = await prisma.lead.create({
    data: { agencyId, customerId, status: 'SOLD', priorityScore: 12345 },
  });
  soldLeadId = soldLead.id;
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('recomputeAgencyLeadPriority with no closedStatuses argument falls back to the shared default and never touches a SOLD lead', async () => {
  const count = await recomputeAgencyLeadPriority(agencyId, null, null);
  assert.ok(count >= 1, 'the active lead must be counted');

  const activeAfter = await prisma.lead.findUnique({ where: { id: activeLeadId } });
  assert.notEqual(activeAfter.priorityScore, 0, 'the active lead must be recomputed to a real score');

  const soldAfter = await prisma.lead.findUnique({ where: { id: soldLeadId } });
  assert.equal(soldAfter.priorityScore, 12345, 'a SOLD lead (default-closed) must never be recomputed');
});

test('a configured Agency.closedLeadStatuses is honored — a status added to the closed list stops being recomputed even though it is not closed by default', async () => {
  const agency = await prisma.agency.create({ data: { name: `Priority Configured Agency ${suffix}`, closedLeadStatuses: ['FOLLOW_UP'] } });
  const customer = await prisma.customer.create({ data: { firstName: 'Configured', lastName: 'Recompute' } });
  const lead = await prisma.lead.create({ data: { agencyId: agency.id, customerId: customer.id, status: 'FOLLOW_UP', priorityScore: 999 } });

  await recomputeAgencyLeadPriority(agency.id, null, agency.closedLeadStatuses);
  const leadAfter = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(leadAfter.priorityScore, 999, 'a status this agency configured as closed must never be recomputed');

  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
  await prisma.agency.delete({ where: { id: agency.id } });
});

test('recomputeAllLeadPriorities reads each agency\'s own closedLeadStatuses from the database', async () => {
  const result = await recomputeAllLeadPriorities();
  assert.ok(result.agencies >= 1);
  assert.ok(result.leadsChecked >= 1);

  const soldAfter = await prisma.lead.findUnique({ where: { id: soldLeadId } });
  assert.equal(soldAfter.priorityScore, 12345, 'the full-sweep entrypoint must also respect the default closed-status set');
});

test('DEFAULT_CLOSED_STATUSES matches the real schema default exactly', () => {
  assert.deepEqual(
    [...DEFAULT_CLOSED_STATUSES].sort(),
    ['SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED'].sort()
  );
});
