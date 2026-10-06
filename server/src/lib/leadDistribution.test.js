// Pure-function tests for pickAgentIndex/normalizeZip/normalizeCity, plus
// real-database integration tests for resolveVendorAssignment (including
// the new two-stage office-aware OFFICE_SPLIT/ALPHA_SPLIT engine) and the
// atomic Moshpit claim — matches this app's own testing philosophy (no
// mocked Prisma for logic that IS a database query). Run with a real
// DATABASE_URL, same as agencyChat.test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/leadDistribution.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { pickAgentIndex, normalizeZip, normalizeCity, resolveVendorAssignment, resolveManualAssignment } = require('./leadDistribution');

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

test('normalizeZip zero-pads to 5 digits and strips non-digits', () => {
  assert.equal(normalizeZip('4101'), '04101');
  assert.equal(normalizeZip('32301'), '32301');
  assert.equal(normalizeZip('32301-1234'), '32301');
  assert.equal(normalizeZip(''), null);
  assert.equal(normalizeZip(null), null);
});

test('normalizeCity trims and uppercases', () => {
  assert.equal(normalizeCity(' tallahassee '), 'TALLAHASSEE');
  assert.equal(normalizeCity(''), '');
});

const suffix = Date.now();
let agencyId;
let producerIds = [];
let roundRobinVendorId;
let selectedVendorId;
let moshpitVendorId;
let officeSplitVendorId;

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

  const officeSplitVendor = await prisma.vendor.create({
    data: { name: 'Office Split Vendor', email: 'office@test.local', agencyId, product: 'Auto', distributionMode: 'OFFICE_SPLIT' },
  });
  officeSplitVendorId = officeSplitVendor.id;
});

after(async () => {
  await prisma.officeAlphaAssignment.deleteMany({ where: { office: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.office.deleteMany({ where: { agencyId } });
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

test('OFFICE_SPLIT with no offices at all sends straight to the Moshpit with an honest reason', async () => {
  const vendor = await prisma.vendor.findUnique({ where: { id: officeSplitVendorId } });
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { zip: '32301' }));
  assert.equal(result.assignedToId, null);
  assert.equal(result.mode, 'MOSHPIT');
  assert.match(result.reason, /no offices/i);
});

test('a zip-range match routes to the right office, then dispatches by that office\'s own routingMode (ROUND_ROBIN)', async () => {
  const office = await prisma.office.create({
    data: { agencyId, name: 'Tallahassee', routingZipRanges: [{ start: '32300', end: '32399' }], routingMode: 'ROUND_ROBIN' },
  });
  await prisma.user.update({ where: { id: producerIds[0] }, data: { officeId: office.id } });

  const vendor = await prisma.vendor.findUnique({ where: { id: officeSplitVendorId } });
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { zip: '32301', lastName: 'Zimmerman' }));
  assert.equal(result.assignedToId, producerIds[0], 'the only active producer at the matching office should get it, regardless of last name');
  assert.equal(result.mode, 'OFFICE_SPLIT');

  await prisma.office.delete({ where: { id: office.id } });
  await prisma.user.update({ where: { id: producerIds[0] }, data: { officeId: null } });
});

test('a city match routes to the right office when no zip range matches', async () => {
  const office = await prisma.office.create({
    data: { agencyId, name: 'Jacksonville', routingCities: ['JACKSONVILLE'], routingMode: 'ROUND_ROBIN' },
  });
  await prisma.user.update({ where: { id: producerIds[0] }, data: { officeId: office.id } });

  const vendor = await prisma.vendor.findUnique({ where: { id: officeSplitVendorId } });
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { zip: '99999', city: 'Jacksonville' }));
  assert.equal(result.assignedToId, producerIds[0], 'a city-name match should win when no zip range matches');

  await prisma.office.delete({ where: { id: office.id } });
  await prisma.user.update({ where: { id: producerIds[0] }, data: { officeId: null } });
});

test('ALPHA_SPLIT office: letter claim wins, unclaimed letter falls to the fallback row, and an unconfigured office goes to the Moshpit', async () => {
  const office = await prisma.office.create({
    data: { agencyId, name: 'Alpha Office', isDefaultOffice: true, routingMode: 'ALPHA_SPLIT' },
  });
  await prisma.user.updateMany({ where: { id: { in: [producerIds[0], producerIds[1]] } }, data: { officeId: office.id } });

  // No alpha assignments configured yet — must go to the Moshpit, never a
  // silent/guessed assignee.
  const vendor = await prisma.vendor.findUnique({ where: { id: officeSplitVendorId } });
  const unconfigured = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { lastName: 'Adams' }));
  assert.equal(unconfigured.assignedToId, null);
  assert.equal(unconfigured.mode, 'MOSHPIT');
  assert.match(unconfigured.reason, /alpha-split not configured/i);

  await prisma.officeAlphaAssignment.create({ data: { officeId: office.id, userId: producerIds[0], letters: ['A', 'B', 'C'] } });
  await prisma.officeAlphaAssignment.create({ data: { officeId: office.id, userId: producerIds[1], letters: [], isFallback: true } });

  const claimed = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { lastName: 'Adams' }));
  assert.equal(claimed.assignedToId, producerIds[0]);
  assert.equal(claimed.mode, 'OFFICE_SPLIT');

  const unclaimedLetter = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { lastName: 'Zimmerman' }));
  assert.equal(unclaimedLetter.assignedToId, producerIds[1], 'an unclaimed letter must land on the fallback producer, never a guess');

  await prisma.officeAlphaAssignment.deleteMany({ where: { officeId: office.id } });
  await prisma.office.delete({ where: { id: office.id } });
  await prisma.user.updateMany({ where: { id: { in: [producerIds[0], producerIds[1]] } }, data: { officeId: null } });
});

test('an ALPHA_SPLIT office ignores a letter claim from a producer no longer actually at this office', async () => {
  const office = await prisma.office.create({ data: { agencyId, name: 'Stale Claim Office', isDefaultOffice: true, routingMode: 'ALPHA_SPLIT' } });
  await prisma.user.update({ where: { id: producerIds[1] }, data: { officeId: office.id } });
  // producerIds[0] claims letters here but never actually works at this office.
  await prisma.officeAlphaAssignment.create({ data: { officeId: office.id, userId: producerIds[0], letters: ['A'] } });
  await prisma.officeAlphaAssignment.create({ data: { officeId: office.id, userId: producerIds[1], letters: [], isFallback: true } });

  const vendor = await prisma.vendor.findUnique({ where: { id: officeSplitVendorId } });
  const result = await prisma.$transaction((tx) => resolveVendorAssignment(tx, vendor, { lastName: 'Adams' }));
  assert.equal(result.assignedToId, producerIds[1], 'the stale claim must be ignored and fall through to the fallback producer');

  await prisma.officeAlphaAssignment.deleteMany({ where: { officeId: office.id } });
  await prisma.office.delete({ where: { id: office.id } });
  await prisma.user.update({ where: { id: producerIds[1] }, data: { officeId: null } });
});

test('resolveManualAssignment OFFICE_SPLIT/ALPHA_SPLIT routes the same way as the vendor path, using row city/zip', async () => {
  const office = await prisma.office.create({
    data: { agencyId, name: 'Manual Office', routingZipRanges: [{ start: '10000', end: '10099' }], routingMode: 'ROUND_ROBIN' },
  });
  await prisma.user.update({ where: { id: producerIds[2] }, data: { officeId: office.id } });

  const result = await prisma.$transaction((tx) => resolveManualAssignment(tx, { agencyId, mode: 'OFFICE_SPLIT', cursor: 0, zip: '10050' }));
  assert.equal(result.assignedToId, producerIds[2]);
  assert.equal(result.mode, 'OFFICE_SPLIT');

  await prisma.office.delete({ where: { id: office.id } });
  await prisma.user.update({ where: { id: producerIds[2] }, data: { officeId: null } });
});
