// Pure-function tests for pickAgentIndex, plus a real-database integration
// test for resolveVendorAssignment and the atomic Moshpit claim (matches
// this app's own testing philosophy — no mocked Prisma for logic that IS a
// database query). Run with a real DATABASE_URL, same as agencyChat.test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/leadDistribution.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { pickAgentIndex, alphaSplitIndex, resolveVendorAssignment } = require('./leadDistribution');

test('pickAgentIndex cycles through candidates in order as the cursor advances', () => {
  assert.equal(pickAgentIndex(1, 3), 1);
  assert.equal(pickAgentIndex(2, 3), 2);
  assert.equal(pickAgentIndex(3, 3), 0);
  assert.equal(pickAgentIndex(4, 3), 1);
});

test('pickAgentIndex handles a single candidate (always index 0)', () => {
  assert.equal(pickAgentIndex(1, 1), 0);
  assert.equal(pickAgentIndex(99, 1), 0);
});

test('pickAgentIndex returns null for zero or invalid candidate counts', () => {
  assert.equal(pickAgentIndex(5, 0), null);
  assert.equal(pickAgentIndex(5, -1), null);
});

test('alphaSplitIndex partitions A-Z evenly across candidates', () => {
  // 2 candidates: A-M -> 0, N-Z -> 1
  assert.equal(alphaSplitIndex('Adams', 2), 0);
  assert.equal(alphaSplitIndex('Miller', 2), 0);
  assert.equal(alphaSplitIndex('Nolan', 2), 1);
  assert.equal(alphaSplitIndex('Zimmerman', 2), 1);
});

test('alphaSplitIndex is case-insensitive and clamps non-letter/empty names to the first bucket', () => {
  assert.equal(alphaSplitIndex('adams', 2), 0);
  assert.equal(alphaSplitIndex('', 2), 0);
  assert.equal(alphaSplitIndex(null, 2), 0);
});

test('alphaSplitIndex never returns an out-of-range bucket for an uneven split', () => {
  for (const name of ['Adams', 'Miller', 'Nolan', 'Zimmerman', '123']) {
    const index = alphaSplitIndex(name, 5);
    assert.ok(index >= 0 && index < 5);
  }
});

const suffix = Date.now();
let agencyId;
let producerIds = [];
let roundRobinVendorId;
let selectedVendorId;
let moshpitVendorId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Distribution Test Agency ${suffix}` } });
  agencyId = agency.id;

  const producers = await Promise.all(
    [0, 1, 2].map((i) =>
      prisma.user.create({
        data: { email: `producer-${suffix}-${i}@test.local`, firstName: 'Test', lastName: `Producer${i}`, role: 'PRODUCER', status: 'ACTIVE', agencyId },
      })
    )
  );
  producerIds = producers.map((p) => p.id).sort();

  const roundRobinVendor = await prisma.vendor.create({
    data: { name: 'RR Vendor', email: 'rr@test.local', agencyId, product: 'Auto', distributionMode: 'ROUND_ROBIN' },
  });
  roundRobinVendorId = roundRobinVendor.id;

  const selectedVendor = await prisma.vendor.create({
    data: { name: 'Selected Vendor', email: 'sel@test.local', agencyId, product: 'Auto', distributionMode: 'SELECTED_AGENTS', selectedAgentIds: [producerIds[0], producerIds[1]] },
  });
  selectedVendorId = selectedVendor.id;

  const moshpitVendor = await prisma.vendor.create({
    data: { name: 'Moshpit Vendor', email: 'moshpit@test.local', agencyId, product: 'Auto', distributionMode: 'MOSHPIT' },
  });
  moshpitVendorId = moshpitVendor.id;
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { id: { in: producerIds } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('resolveVendorAssignment MOSHPIT mode always leaves the lead unassigned', async () => {
  const vendor = await prisma.vendor.findUnique({ where: { id: moshpitVendorId } });
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor));
  assert.equal(result.assignedToId, null);
  assert.equal(result.mode, 'MOSHPIT');
});

test('resolveVendorAssignment ROUND_ROBIN cycles through every active producer exactly once per lap', async () => {
  const seen = new Set();
  for (let i = 0; i < producerIds.length; i++) {
    const vendor = await prisma.vendor.findUnique({ where: { id: roundRobinVendorId } });
    const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor));
    assert.ok(producerIds.includes(result.assignedToId));
    seen.add(result.assignedToId);
  }
  assert.equal(seen.size, producerIds.length, 'every producer should have been picked exactly once across one full lap');
});

test('resolveVendorAssignment SELECTED_AGENTS only ever assigns to the vendor\'s chosen agents', async () => {
  const selected = [producerIds[0], producerIds[1]];
  for (let i = 0; i < 5; i++) {
    const vendor = await prisma.vendor.findUnique({ where: { id: selectedVendorId } });
    const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor));
    assert.ok(selected.includes(result.assignedToId), 'assignment must be one of the two selected agents, never the third producer');
    assert.notEqual(result.assignedToId, producerIds[2]);
  }
});

test('resolveVendorAssignment SELECTED_AGENTS with an empty selection falls back to the Moshpit honestly', async () => {
  const vendor = await prisma.vendor.findUnique({ where: { id: selectedVendorId } });
  vendor.selectedAgentIds = [];
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor));
  assert.equal(result.assignedToId, null);
  assert.equal(result.mode, 'MOSHPIT');
  assert.ok(result.reason);
});

test('concurrent round-robin assignments never double-assign the same producer in the same lap', async () => {
  // Reset the cursor so this test's expectations are deterministic
  // regardless of how many times the earlier round-robin test ran.
  await prisma.vendor.update({ where: { id: roundRobinVendorId }, data: { roundRobinCursor: 0 } });
  const vendor = await prisma.vendor.findUnique({ where: { id: roundRobinVendorId } });

  const results = await Promise.all(
    producerIds.map(() => prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor)))
  );
  const assignedIds = results.map((r) => r.assignedToId).sort();
  assert.deepEqual(assignedIds, producerIds, 'concurrent requests within one lap must still land on distinct producers, no duplicates');
});

test('the Moshpit claim is race-safe: only one of two concurrent claims on the same lead succeeds', async () => {
  const customer = await prisma.customer.create({ data: { firstName: 'Claim', lastName: 'Race' } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, vendorId: moshpitVendorId, status: 'NEW', assignedToId: null },
  });

  const [a, b] = await Promise.all([
    prisma.lead.updateMany({ where: { id: lead.id, assignedToId: null }, data: { assignedToId: producerIds[0], status: 'NEW' } }),
    prisma.lead.updateMany({ where: { id: lead.id, assignedToId: null }, data: { assignedToId: producerIds[1], status: 'NEW' } }),
  ]);

  const totalClaimed = a.count + b.count;
  assert.equal(totalClaimed, 1, 'exactly one of the two concurrent claims should have matched assignedToId: null');

  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
});
