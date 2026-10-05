// Real-DB, real-HTTP tests for the bulk lead upload's new distribution
// controls (an Agency Owner picking, per upload, how the batch is routed —
// Moshpit, round robin, a hand-picked subset of producers, or alpha split —
// reusing the exact same lib/leadDistribution.js engine a vendor's
// real-time leads already use). Uses the real multipart POST
// /leads/bulk-import endpoint via fetch()+FormData (not a raw http.request
// multipart hand-build), matching this app's "never mock the database or
// the real HTTP path" convention while keeping the multipart construction
// itself simple and correct.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, producerAId, producerBId, server, port, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Bulk Distribution Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `bulk-dist-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Dist', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const { rawToken } = await createSession(ownerId);
  ownerCookie = `evenflow_session=${rawToken}`;

  const producerA = await prisma.user.create({
    data: { email: `bulk-dist-prod-a-${suffix}@test.local`, passwordHash: hash, firstName: 'Alpha', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerAId = producerA.id;
  const producerB = await prisma.user.create({
    data: { email: `bulk-dist-prod-b-${suffix}@test.local`, passwordHash: hash, firstName: 'Beta', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerBId = producerB.id;
  // Sorted-id candidate order is what the distribution engine actually
  // iterates in — fix it here so round-robin/alpha-split assertions below
  // are deterministic rather than depending on whichever id happened to
  // sort first.
  [producerAId, producerBId] = [producerAId, producerBId].sort();

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.leadImportBatch.deleteMany({ where: { agencyId } });
  await prisma.notification.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerAId, producerBId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, producerAId, producerBId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// A module-level counter, not a per-call index — two different tests'
// rows must never share a phone/email, or createLeadRecord's real
// duplicate-customer detection will (correctly) merge them into one
// Customer, silently renaming one test's lead to another's.
let rowSeq = 0;
function csvFile(rows) {
  const header = 'First Name,Last Name,Phone,Email\n';
  const body = rows
    .map((r) => {
      const i = rowSeq++;
      return `${r.firstName},${r.lastName},555000${1000 + i},test${suffix}${i}@example.com`;
    })
    .join('\n');
  return new Blob([header + body], { type: 'text/csv' });
}

async function uploadBulk({ rows, leadCategory = 'INTERNET', distributionMode, selectedAgentIds }) {
  const form = new FormData();
  form.append('file', csvFile(rows), 'leads.csv');
  form.append('leadCategory', leadCategory);
  if (distributionMode) form.append('distributionMode', distributionMode);
  if (selectedAgentIds) form.append('selectedAgentIds', JSON.stringify(selectedAgentIds));

  const res = await fetch(`${baseUrl}/api/leads/bulk-import`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function leadsForBatch(batchId) {
  // Lead itself has no firstName/lastName — those live on Customer.
  return prisma.lead.findMany({ where: { importBatchId: batchId }, orderBy: { createdAt: 'asc' }, include: { customer: true } });
}

test('no distributionMode supplied defaults to MOSHPIT — unassigned AND moshpit-eligible, not a dead zone', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Jan', lastName: 'Doe' }, { firstName: 'Jun', lastName: 'Smith' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.distributionMode, 'MOSHPIT');
  assert.equal(res.body.sentToMoshpit, 2);

  const leads = await leadsForBatch(res.body.batchId);
  assert.equal(leads.length, 2);
  for (const lead of leads) {
    assert.equal(lead.assignedToId, null);
    assert.equal(lead.moshpitEligible, true, 'a bulk-imported MOSHPIT-mode lead must actually be claimable, not just unassigned');
  }
});

test('ROUND_ROBIN splits a batch evenly across active producers, in sorted-id order', async () => {
  const res = await uploadBulk({
    rows: [
      { firstName: 'A', lastName: 'One' },
      { firstName: 'B', lastName: 'Two' },
      { firstName: 'C', lastName: 'Three' },
      { firstName: 'D', lastName: 'Four' },
    ],
    distributionMode: 'ROUND_ROBIN',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.distributionMode, 'ROUND_ROBIN');
  assert.equal(res.body.assigned, 4);
  assert.equal(res.body.sentToMoshpit, 0);

  const leads = await leadsForBatch(res.body.batchId);
  const assignedIds = leads.map((l) => l.assignedToId);
  // Every lead got assigned to one of the two real producers, and both got used.
  for (const id of assignedIds) assert.ok(id === producerAId || id === producerBId);
  assert.ok(assignedIds.includes(producerAId) && assignedIds.includes(producerBId), 'round robin must actually alternate across both producers, not pin everything to one');
});

test('SELECTED_AGENTS restricts assignment to exactly the chosen producer(s)', async () => {
  const res = await uploadBulk({
    rows: [{ firstName: 'E', lastName: 'Five' }, { firstName: 'F', lastName: 'Six' }, { firstName: 'G', lastName: 'Seven' }],
    distributionMode: 'SELECTED_AGENTS',
    selectedAgentIds: [producerAId],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.assigned, 3);

  const leads = await leadsForBatch(res.body.batchId);
  for (const lead of leads) assert.equal(lead.assignedToId, producerAId);
});

test('SELECTED_AGENTS with no agents chosen is rejected before any lead is created', async () => {
  const res = await uploadBulk({
    rows: [{ firstName: 'H', lastName: 'Eight' }],
    distributionMode: 'SELECTED_AGENTS',
    selectedAgentIds: [],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('a mode that resolves to no eligible candidates falls back to Moshpit per row, not a dropped/un-findable lead', async () => {
  const fakeAgentId = '00000000-0000-0000-0000-000000000000';
  const res = await uploadBulk({
    rows: [{ firstName: 'I', lastName: 'Nine' }],
    distributionMode: 'SELECTED_AGENTS',
    selectedAgentIds: [fakeAgentId],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sentToMoshpit, 1);
  const leads = await leadsForBatch(res.body.batchId);
  assert.equal(leads[0].assignedToId, null);
  assert.equal(leads[0].moshpitEligible, true);
});

test('ALPHA_SPLIT routes by each row\'s own last name, not a single value for the whole batch', async () => {
  // 2 candidates: A-M -> first candidate, N-Z -> second (matches
  // alphaSplitIndex's own partitioning, already unit-tested elsewhere).
  const res = await uploadBulk({
    rows: [{ firstName: 'Amy', lastName: 'Adams' }, { firstName: 'Zoe', lastName: 'Zimmerman' }],
    distributionMode: 'ALPHA_SPLIT',
  });
  assert.equal(res.status, 200);
  const leads = await leadsForBatch(res.body.batchId);
  const adams = leads.find((l) => l.customer.firstName === 'Amy');
  const zimmerman = leads.find((l) => l.customer.firstName === 'Zoe');
  assert.equal(adams.assignedToId, producerAId);
  assert.equal(zimmerman.assignedToId, producerBId);
});

test('a multi-lead ROUND_ROBIN batch sends exactly ONE aggregate notification per producer, never one per lead', async () => {
  const before = await prisma.notification.count({ where: { userId: { in: [producerAId, producerBId] }, type: 'lead.assigned' } });
  const res = await uploadBulk({
    rows: [
      { firstName: 'J', lastName: 'Ten' },
      { firstName: 'K', lastName: 'Eleven' },
      { firstName: 'L', lastName: 'Twelve' },
      { firstName: 'M', lastName: 'Thirteen' },
    ],
    distributionMode: 'ROUND_ROBIN',
  });
  assert.equal(res.status, 200);
  const after = await prisma.notification.count({ where: { userId: { in: [producerAId, producerBId] }, type: 'lead.assigned' } });
  assert.equal(after - before, 2, 'one notification per producer for the whole batch, not one per assigned lead');

  const notifs = await prisma.notification.findMany({ where: { userId: { in: [producerAId, producerBId] }, type: 'lead.assigned' }, orderBy: { createdAt: 'desc' }, take: 2 });
  for (const n of notifs) assert.match(n.title, /new lead/i);
});
