// Real-DB, real-HTTP test: GET /leads?source=telemarketer (the query
// behind the Yield/"Live" Transfers screen) must 403 MODULE_NOT_ENTITLED
// for an agency that never had transfersEnabled turned on, and must
// return real telemarketer-sourced leads once it is — a full controlled
// trace from a real telemarketer submission through to the query an
// Agency Owner's screen makes, confirming records aren't silently lost.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let disabledAgencyId, enabledAgencyId;
let disabledOwnerId, disabledOwnerCookie;
let enabledOwnerId, enabledOwnerCookie, enabledTmId, enabledTmCookie;
let server, baseUrl;

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);

  const disabledAgency = await prisma.agency.create({ data: { name: `Not Entitled Agency ${suffix}` } }); // transfersEnabled defaults to false
  disabledAgencyId = disabledAgency.id;
  const disabledOwner = await prisma.user.create({
    data: { agencyId: disabledAgencyId, email: `owner-disabled-${suffix}@test.local`, passwordHash: hash, firstName: 'No', lastName: 'Entitlement', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  disabledOwnerId = disabledOwner.id;
  const disabledOwnerSession = await createSession(disabledOwnerId);
  disabledOwnerCookie = `evenflow_session=${disabledOwnerSession.rawToken}`;

  const enabledAgency = await prisma.agency.create({ data: { name: `Entitled Agency ${suffix}`, transfersEnabled: true } });
  enabledAgencyId = enabledAgency.id;
  const enabledOwner = await prisma.user.create({
    data: { agencyId: enabledAgencyId, email: `owner-enabled-${suffix}@test.local`, passwordHash: hash, firstName: 'Has', lastName: 'Entitlement', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  enabledOwnerId = enabledOwner.id;
  const enabledOwnerSession = await createSession(enabledOwnerId);
  enabledOwnerCookie = `evenflow_session=${enabledOwnerSession.rawToken}`;

  const tm = await prisma.user.create({
    data: { email: `tm-entitlement-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  enabledTmId = tm.id;
  await prisma.telemarketerAssignment.create({ data: { telemarketerId: enabledTmId, agencyId: enabledAgencyId, status: 'ACTIVE' } });
  const tmSession = await createSession(enabledTmId);
  enabledTmCookie = `evenflow_session=${tmSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId: { in: [disabledAgencyId, enabledAgencyId] } } } });
  await prisma.lead.deleteMany({ where: { agencyId: { in: [disabledAgencyId, enabledAgencyId] } } });
  await prisma.telemarketerAssignment.deleteMany({ where: { telemarketerId: enabledTmId } });
  await prisma.session.deleteMany({ where: { userId: { in: [disabledOwnerId, enabledOwnerId, enabledTmId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [disabledOwnerId, enabledOwnerId, enabledTmId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [disabledAgencyId, enabledAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('GET /leads?source=telemarketer 403s MODULE_NOT_ENTITLED for an agency with transfersEnabled: false', async () => {
  const res = await fetch(`${baseUrl}/api/leads?source=telemarketer`, { headers: { Cookie: disabledOwnerCookie } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'MODULE_NOT_ENTITLED');
});

test('controlled trace: a real telemarketer submission reaches GET /leads?source=telemarketer for an entitled agency', async () => {
  const createRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: enabledTmCookie },
    body: JSON.stringify({ agencyId: enabledAgencyId, firstName: 'Trace', lastName: 'Lead', phone: '5559998888', product: 'Auto' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.lead.source, 'telemarketer', 'source must be server-set, not client-trusted');

  const listRes = await fetch(`${baseUrl}/api/leads?source=telemarketer`, { headers: { Cookie: enabledOwnerCookie } });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(listBody.leads.some((l) => l.id === created.lead.id), 'the real submitted lead must appear on the entitled agency Owner query — nothing lost between intake and screen');
});
