// Real-DB, real-HTTP test: every telemarketer-submitted lead now enters
// the Moshpit (claimable by any eligible producer), not just ones the TM
// explicitly flags as a live transfer. Confirms the moshpitEligible fix
// in leads.js's createLeadRecord + the GET /moshpit and POST /:id/claim
// query guards that already OR-match on it.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, tmId, tmCookie, producerId, producerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `TM Moshpit Test Agency ${suffix}`, transfersEnabled: true } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const tm = await prisma.user.create({
    data: { email: `tm-moshpit-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  tmId = tm.id;
  await prisma.telemarketerAssignment.create({ data: { telemarketerId: tmId, agencyId, status: 'ACTIVE' } });
  const tmSession = await createSession(tmId);
  tmCookie = `evenflow_session=${tmSession.rawToken}`;

  const producer = await prisma.user.create({
    data: { email: `prod-moshpit-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId },
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
  await prisma.telemarketerAssignment.deleteMany({ where: { telemarketerId: tmId } });
  await prisma.session.deleteMany({ where: { userId: { in: [tmId, producerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [tmId, producerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a telemarketer lead NOT flagged as a live transfer still becomes Moshpit-eligible', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: tmCookie },
    body: JSON.stringify({ agencyId, firstName: 'Pat', lastName: 'Regular', phone: '5551234567', product: 'Auto', isLiveTransfer: false }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.lead.moshpitEligible, true, 'a plain (non-live-transfer) TM lead must be moshpitEligible');
  assert.equal(body.lead.isLiveTransfer, false, 'isLiveTransfer stays an honest, independent flag');
  assert.equal(body.lead.assignedToId, null);

  const moshpitRes = await fetch(`${baseUrl}/api/leads/moshpit`, { headers: { Cookie: producerCookie } });
  assert.equal(moshpitRes.status, 200);
  const moshpitBody = await moshpitRes.json();
  assert.ok(moshpitBody.leads.some((l) => l.id === body.lead.id), 'the plain TM lead must appear in the Moshpit pool');

  const claimRes = await fetch(`${baseUrl}/api/leads/${body.lead.id}/claim`, { method: 'POST', headers: { Cookie: producerCookie } });
  assert.equal(claimRes.status, 200, 'a producer must be able to claim a plain TM lead from the Moshpit');
  const claimBody = await claimRes.json();
  assert.equal(claimBody.lead.assignedToId, producerId);
});

test('a telemarketer lead flagged as a live transfer is still Moshpit-eligible (unchanged behavior)', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: tmCookie },
    body: JSON.stringify({ agencyId, firstName: 'Live', lastName: 'Transfer', phone: '5559876543', product: 'Home', isLiveTransfer: true }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.lead.moshpitEligible, true);
  assert.equal(body.lead.isLiveTransfer, true);
});
