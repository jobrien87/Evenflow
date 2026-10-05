// Real-database integration tests for the Break Room gate — no mocked
// Prisma, matching this codebase's established testing philosophy.
//   DATABASE_URL=postgresql://... node --test src/lib/breakRoom.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { canAccessBreakRoom, resolveSettings } = require('./breakRoom');
const { validateScore } = require('./breakRoomAntiCheat');

const suffix = Date.now();
let agencyId;
let producerId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Break Room Test Agency ${suffix}`, breakRoomEnabled: true } });
  agencyId = agency.id;
  const producer = await prisma.user.create({
    data: { agencyId, email: `breakroom-${suffix}@test.local`, passwordHash: 'x', firstName: 'Break', lastName: 'Tester', role: 'PRODUCER', status: 'ACTIVE' },
  });
  producerId = producer.id;
});

after(async () => {
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.user.delete({ where: { id: producerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

async function freshEntry(data = {}) {
  await prisma.timeClockEntry.deleteMany({ where: { userId: producerId } });
  return prisma.timeClockEntry.create({ data: { userId: producerId, agencyId, ...data } });
}

test('canAccessBreakRoom: clocked-out employee (no open entry) cannot access', async () => {
  await prisma.timeClockEntry.deleteMany({ where: { userId: producerId } });
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'NOT_CLOCKED_IN');
});

test('canAccessBreakRoom: a working employee (clocked in, no break/lunch) cannot access', async () => {
  await freshEntry();
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'WRONG_STATE');
  assert.equal(result.state, 'CLOCKED_IN');
});

test('canAccessBreakRoom: an employee on an active break CAN access', async () => {
  await freshEntry({ breakStartAt: new Date() });
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'ON_BREAK');
});

test('canAccessBreakRoom: lunch is NOT eligible by default', async () => {
  await freshEntry({ lunchStartAt: new Date() });
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'WRONG_STATE');
  assert.equal(result.state, 'ON_LUNCH');
});

test('canAccessBreakRoom: lunch becomes eligible once the agency opts in', async () => {
  await prisma.agency.update({ where: { id: agencyId }, data: { breakRoomSettings: { lunchEligible: true } } });
  await freshEntry({ lunchStartAt: new Date() });
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'ON_LUNCH');
  await prisma.agency.update({ where: { id: agencyId }, data: { breakRoomSettings: null } });
});

test('canAccessBreakRoom: a disabled module blocks access even while on break', async () => {
  await prisma.agency.update({ where: { id: agencyId }, data: { breakRoomEnabled: false } });
  await freshEntry({ breakStartAt: new Date() });
  const user = await prisma.user.findUnique({ where: { id: producerId } });
  const result = await canAccessBreakRoom(user);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'MODULE_DISABLED');
  await prisma.agency.update({ where: { id: agencyId }, data: { breakRoomEnabled: true } });
});

test('canAccessBreakRoom: a role with no clock state (Agency Owner) is never eligible', async () => {
  const owner = { role: 'AGENCY_OWNER', id: 'fake', agencyId };
  const result = await canAccessBreakRoom(owner);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'NOT_ELIGIBLE_ROLE');
});

test('resolveSettings: null falls back to the full seeded default, a partial override is merged', () => {
  const def = resolveSettings(null);
  assert.equal(def.games.CONGO_LINE, true);
  assert.equal(def.lunchEligible, false);

  const partial = resolveSettings({ games: { BUCKETS: false } });
  assert.equal(partial.games.BUCKETS, false);
  assert.equal(partial.games.CONGO_LINE, true, 'untouched games keep their default');
  assert.equal(partial.pickMeUpEnabled, true);
});

test('validateScore: rejects an impossible score for its claimed duration', () => {
  const result = validateScore('CONGO_LINE', { score: 500000, metrics: {}, durationMs: 3000 });
  assert.equal(result.valid, false);
});

test('validateScore: accepts a real, plausible score', () => {
  const result = validateScore('CONGO_LINE', { score: 4500, metrics: { dancersCollected: 20 }, durationMs: 60000 });
  assert.equal(result.valid, true);
  assert.equal(result.flagged, false);
});

test('validateScore: flags (but does not hard-reject) a metric/score mismatch', () => {
  // Claims 40 dancers (min 100pts each = 4000 floor) but a near-zero score.
  const result = validateScore('CONGO_LINE', { score: 50, metrics: { dancersCollected: 40 }, durationMs: 60000 });
  assert.equal(result.valid, true);
  assert.equal(result.flagged, true);
  assert.equal(result.reason, 'METRIC_SCORE_MISMATCH');
});

test('validateScore: rejects a session shorter than the minimum plausible duration', () => {
  const result = validateScore('BUCKETS', { score: 500, metrics: {}, durationMs: 500 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'DURATION_TOO_SHORT');
});
