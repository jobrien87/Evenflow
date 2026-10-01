// Pure unit tests for pickWinner (no DB), plus a real-DB integration test
// for checkAgentOfMonth's idempotent award behavior.
//   DATABASE_URL=postgresql://... node --test src/lib/agentOfMonth.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { pickWinner, checkAgentOfMonth, previousMonthRange } = require('./agentOfMonth');

test('pickWinner: highest sold count wins', () => {
  const leads = [
    { assignedToId: 'a', salePremiumCents: 1000 },
    { assignedToId: 'a', salePremiumCents: 1000 },
    { assignedToId: 'b', salePremiumCents: 5000 },
  ];
  const winner = pickWinner(leads);
  assert.equal(winner.userId, 'a');
  assert.equal(winner.soldCount, 2);
});

test('pickWinner: ties broken by higher total premium', () => {
  const leads = [
    { assignedToId: 'a', salePremiumCents: 1000 },
    { assignedToId: 'b', salePremiumCents: 2000 },
  ];
  const winner = pickWinner(leads);
  assert.equal(winner.userId, 'b');
});

test('pickWinner: no sold leads returns null, never a fabricated winner', () => {
  assert.equal(pickWinner([]), null);
});

const suffix = Date.now();

test('checkAgentOfMonth: awards the real previous-month winner, exactly once', async () => {
  const agency = await prisma.agency.create({ data: { name: `AgentOfMonth Test Agency ${suffix}` } });
  const producer = await prisma.user.create({
    data: { agencyId: agency.id, email: `aom-${suffix}@test.local`, passwordHash: 'x', firstName: 'Win', lastName: 'Ner', role: 'PRODUCER', status: 'ACTIVE' },
  });

  const { start } = previousMonthRange(new Date());
  const midMonth = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000);
  const customer = await prisma.customer.create({ data: { firstName: 'AOM', lastName: 'Cust' } });
  const lead = await prisma.lead.create({
    data: { agencyId: agency.id, customerId: customer.id, assignedToId: producer.id, status: 'SOLD', salePremiumCents: 10000 },
  });
  // Backdate updatedAt into last month via a direct update (createdAt/updatedAt
  // default to now() on create) so the real previous-month query window picks it up.
  await prisma.lead.update({ where: { id: lead.id }, data: { updatedAt: midMonth } });

  const result1 = await checkAgentOfMonth(new Date());
  assert.ok(result1.awarded >= 1, 'at least this agency should get a fresh award');

  const badge = await prisma.userBadge.findFirst({ where: { agencyId: agency.id, type: 'AGENT_OF_THE_MONTH' } });
  assert.ok(badge, 'a real UserBadge row was created');
  assert.equal(badge.userId, producer.id);

  // Running it again must not award a second badge for the same period —
  // the unique constraint plus the existing-check make this a true no-op.
  const countBefore = await prisma.userBadge.count({ where: { agencyId: agency.id, type: 'AGENT_OF_THE_MONTH' } });
  await checkAgentOfMonth(new Date());
  const countAfter = await prisma.userBadge.count({ where: { agencyId: agency.id, type: 'AGENT_OF_THE_MONTH' } });
  assert.equal(countAfter, countBefore, 'idempotent — no duplicate award for the same month');
});
