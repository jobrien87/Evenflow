// Real-DB, real-HTTP test: an Agency Owner/Manager manually logging a lead
// via "Add a Lead" can now flag it as a live transfer too, not just a
// Telemarketer's own submission — same isLiveTransfer field, same
// Moshpit-claimable behavior (GET /leads/moshpit's OR clause already
// matches on isLiveTransfer regardless of who set it). A plain PRODUCER
// must still never be able to set it.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, managerId, managerCookie, producerId, producerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Agency Live Transfer Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `alt-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;

  const manager = await prisma.user.create({
    data: { email: `alt-manager-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'Manager', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' },
  });
  managerId = manager.id;
  const managerSession = await createSession(managerId);
  managerCookie = `evenflow_session=${managerSession.rawToken}`;

  const producer = await prisma.user.create({
    data: { email: `alt-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const producerSession = await createSession(producerId);
  producerCookie = `evenflow_session=${producerSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, managerId, producerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, managerId, producerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('an AGENCY_OWNER manually adding a lead can flag it as a live transfer, and it is instantly Moshpit-claimable', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ firstName: 'Owner', lastName: 'Transfer', phone: '5551112222', product: 'Auto', isLiveTransfer: true }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.lead.isLiveTransfer, true);
  assert.equal(body.lead.leadType, 'TRANSFER', 'deriveLeadType must prioritize isLiveTransfer over everything else, exactly like a TM live transfer');

  const moshpitRes = await fetch(`${baseUrl}/api/leads/moshpit`, { headers: { Cookie: producerCookie } });
  assert.equal(moshpitRes.status, 200);
  const moshpitBody = await moshpitRes.json();
  assert.ok(moshpitBody.leads.some((l) => l.id === body.lead.id), 'a manually-added live transfer must appear in the Moshpit pool just like a TM one');

  const claimRes = await fetch(`${baseUrl}/api/leads/${body.lead.id}/claim`, { method: 'POST', headers: { Cookie: producerCookie } });
  assert.equal(claimRes.status, 200, 'a producer must be able to claim a manually-added live transfer from the Moshpit');
});

test('an AGENCY_MANAGER can also flag a manually-added lead as a live transfer', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: managerCookie },
    body: JSON.stringify({ firstName: 'Manager', lastName: 'Transfer', phone: '5553334444', product: 'Home', isLiveTransfer: true }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.lead.isLiveTransfer, true);
});

test('a plain PRODUCER cannot flag a lead as a live transfer — the field is silently ignored, not honored', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ agencyId, firstName: 'Producer', lastName: 'Attempt', phone: '5555556666', product: 'Auto', isLiveTransfer: true }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.lead.isLiveTransfer, false, 'only TELEMARKETER/AGENCY_OWNER/AGENCY_MANAGER may set this, regardless of what the request body claims');
});
