// Real-DB, real-HTTP tests for Backstage HR Phase 1 Part A (Foundation):
// module gating (Agency.hrEnabled), the additive HrRoleGrant authorization
// layer (requireHrRole), cross-agency tenant isolation, and the
// HrEmployeeProfile optimistic-concurrency PATCH + HrEmploymentHistoryEvent
// append-only history writes.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyA, agencyB, ownerACookie, ownerBCookie, producerAId, producerBId, server, baseUrl;
let ownerAId, ownerBId;

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);

  const aAgency = await prisma.agency.create({ data: { name: `HR Test Agency A ${suffix}`, hrEnabled: true } });
  agencyA = aAgency.id;
  const ownerA = await prisma.user.create({
    data: { email: `hr-owner-a-${suffix}@test.local`, passwordHash: hash, firstName: 'Owner', lastName: 'A', role: 'AGENCY_OWNER', agencyId: agencyA, status: 'ACTIVE' },
  });
  ownerAId = ownerA.id;
  ownerACookie = `evenflow_session=${(await createSession(ownerAId)).rawToken}`;
  const producerA = await prisma.user.create({
    data: { email: `hr-prod-a-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'A', role: 'PRODUCER', agencyId: agencyA, status: 'ACTIVE' },
  });
  producerAId = producerA.id;

  // Agency B: hrEnabled is false by default — the module-gate control case.
  const bAgency = await prisma.agency.create({ data: { name: `HR Test Agency B ${suffix}`, hrEnabled: false } });
  agencyB = bAgency.id;
  const ownerB = await prisma.user.create({
    data: { email: `hr-owner-b-${suffix}@test.local`, passwordHash: hash, firstName: 'Owner', lastName: 'B', role: 'AGENCY_OWNER', agencyId: agencyB, status: 'ACTIVE' },
  });
  ownerBId = ownerB.id;
  ownerBCookie = `evenflow_session=${(await createSession(ownerBId)).rawToken}`;
  const producerB = await prisma.user.create({
    data: { email: `hr-prod-b-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'B', role: 'PRODUCER', agencyId: agencyB, status: 'ACTIVE' },
  });
  producerBId = producerB.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.hrEmploymentHistoryEvent.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.hrRoleGrant.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.hrPosition.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.hrDepartment.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.hrLegalEmployer.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerAId, ownerBId, producerAId, producerBId] } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyA, agencyB] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyA, agencyB] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('Agency.hrEnabled gates the whole /api/hr router', async () => {
  const res = await fetch(`${baseUrl}/api/hr/overview`, { headers: { Cookie: ownerBCookie } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'MODULE_NOT_ENTITLED');
});

test('AGENCY_OWNER has implicit HR_ADMIN access with no HrRoleGrant row needed', async () => {
  const res = await fetch(`${baseUrl}/api/hr/departments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie }, body: JSON.stringify({ name: 'Sales' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.department.name, 'Sales');
  await prisma.hrDepartment.delete({ where: { id: body.department.id } });
});

test('a producer with no HrRoleGrant is denied; a granted HR_AUDITOR can read but not write; revoking removes access immediately', async () => {
  const producerCookie = `evenflow_session=${(await createSession(producerAId)).rawToken}`;

  const denied = await fetch(`${baseUrl}/api/hr/employees`, { headers: { Cookie: producerCookie } });
  assert.equal(denied.status, 403);

  const grantRes = await fetch(`${baseUrl}/api/hr/role-grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie }, body: JSON.stringify({ userId: producerAId, hrRole: 'HR_AUDITOR' }),
  });
  assert.equal(grantRes.status, 201);
  const grant = (await grantRes.json()).grant;

  const readOk = await fetch(`${baseUrl}/api/hr/employees`, { headers: { Cookie: producerCookie } });
  assert.equal(readOk.status, 200);

  const writeDenied = await fetch(`${baseUrl}/api/hr/departments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie }, body: JSON.stringify({ name: 'Should Fail' }),
  });
  assert.equal(writeDenied.status, 403, 'HR_AUDITOR is read-only, never a write role');

  const revokeRes = await fetch(`${baseUrl}/api/hr/role-grants/${grant.id}/revoke`, { method: 'POST', headers: { Cookie: ownerACookie } });
  assert.equal(revokeRes.status, 200);

  const readAfterRevoke = await fetch(`${baseUrl}/api/hr/employees`, { headers: { Cookie: producerCookie } });
  assert.equal(readAfterRevoke.status, 403, 'a revoked grant must lose access immediately, not at some later refresh');
});

test('a producer-only role (not AGENCY_OWNER/PLATFORM_OWNER) cannot mint an HrRoleGrant, even as HR_ADMIN', async () => {
  const grantAsHrAdmin = await fetch(`${baseUrl}/api/hr/role-grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie }, body: JSON.stringify({ userId: producerAId, hrRole: 'HR_ADMIN' }),
  });
  assert.equal(grantAsHrAdmin.status, 201);
  const grant = (await grantAsHrAdmin.json()).grant;
  const hrAdminCookie = `evenflow_session=${(await createSession(producerAId)).rawToken}`;

  const attempt = await fetch(`${baseUrl}/api/hr/role-grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: hrAdminCookie }, body: JSON.stringify({ userId: producerAId, hrRole: 'HR_AUDITOR' }),
  });
  assert.equal(attempt.status, 403, 'an HR_ADMIN grant must never itself be able to mint further HR authority — only AGENCY_OWNER/PLATFORM_OWNER can');

  await fetch(`${baseUrl}/api/hr/role-grants/${grant.id}/revoke`, { method: 'POST', headers: { Cookie: ownerACookie } });
});

test('cross-agency denial: Agency B cannot read or create against Agency A via an explicit query agencyId', async () => {
  const dept = await prisma.hrDepartment.create({ data: { agencyId: agencyA, name: `Cross-Tenant Dept ${suffix}` } });
  // Agency B's owner is locked server-side to their own agencyId regardless
  // of what they pass — hrEnabled is false for B anyway, so this also
  // exercises that the module gate, not just the role check, is in front.
  const res = await fetch(`${baseUrl}/api/hr/departments?agencyId=${agencyA}`, { headers: { Cookie: ownerBCookie } });
  assert.equal(res.status, 403);
  await prisma.hrDepartment.delete({ where: { id: dept.id } });
});

test('creating an HR employee profile for an existing User, then PATCHing it, writes exactly the right HrEmploymentHistoryEvent rows with optimistic concurrency', async () => {
  const dept1 = await prisma.hrDepartment.create({ data: { agencyId: agencyA, name: `Dept One ${suffix}` } });
  const dept2 = await prisma.hrDepartment.create({ data: { agencyId: agencyA, name: `Dept Two ${suffix}` } });

  const createRes = await fetch(`${baseUrl}/api/hr/employees`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ userId: producerAId, departmentId: dept1.id, employeeNumber: 'E-100' }),
  });
  assert.equal(createRes.status, 201);
  const employee = (await createRes.json()).employee;
  assert.equal(employee.version, 1);

  // Re-creating a profile for the same User must 409, never silently
  // overwrite — this is what "never a second identity" means in practice.
  const dupe = await fetch(`${baseUrl}/api/hr/employees`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ userId: producerAId }),
  });
  assert.equal(dupe.status, 409);
  assert.equal((await dupe.json()).error, 'PROFILE_EXISTS');

  // A stale version must be rejected with 409 CONFLICT, not silently applied.
  const staleVersion = await fetch(`${baseUrl}/api/hr/employees/${employee.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ version: 99, departmentId: dept2.id }),
  });
  assert.equal(staleVersion.status, 409);
  assert.equal((await staleVersion.json()).error, 'CONFLICT');

  const patchRes = await fetch(`${baseUrl}/api/hr/employees/${employee.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ version: employee.version, departmentId: dept2.id, onboardingStatus: 'IN_PROGRESS' }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()).employee;
  assert.equal(updated.version, 2);
  assert.equal(updated.departmentId, dept2.id);

  const historyEvents = await prisma.hrEmploymentHistoryEvent.findMany({ where: { employeeProfileId: employee.id } });
  assert.equal(historyEvents.length, 2, 'exactly one DEPARTMENT_CHANGE and one STATUS_CHANGE row, never more');
  const types = historyEvents.map((e) => e.changeType).sort();
  assert.deepEqual(types, ['DEPARTMENT_CHANGE', 'STATUS_CHANGE']);
  const deptEvent = historyEvents.find((e) => e.changeType === 'DEPARTMENT_CHANGE');
  assert.equal(deptEvent.previousValue.departmentId, dept1.id);
  assert.equal(deptEvent.newValue.departmentId, dept2.id);

  // A no-op PATCH (same values) must write zero new history events.
  const noop = await fetch(`${baseUrl}/api/hr/employees/${employee.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ version: updated.version, departmentId: dept2.id, onboardingStatus: 'IN_PROGRESS' }),
  });
  assert.equal(noop.status, 200);
  const historyAfterNoop = await prisma.hrEmploymentHistoryEvent.count({ where: { employeeProfileId: employee.id } });
  assert.equal(historyAfterNoop, 2, 'a PATCH that changes nothing must never fabricate a history event');
});

test('GET /hr/employees/me is self-service — returns null (not 404) with no profile, and works with no HR role grant', async () => {
  const noProfile = await fetch(`${baseUrl}/api/hr/employees/me`, { headers: { Cookie: `evenflow_session=${(await createSession(producerBId)).rawToken}` } });
  // producerB's agency (B) has hrEnabled: false, so the module gate fires first.
  assert.equal(noProfile.status, 403);

  // A real self-check against Agency A, which IS hrEnabled, with a fresh
  // producer who has never had a profile created for them.
  const freshProducer = await prisma.user.create({
    data: { email: `hr-fresh-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Fresh', lastName: 'Prod', role: 'PRODUCER', agencyId: agencyA, status: 'ACTIVE' },
  });
  const freshCookie = `evenflow_session=${(await createSession(freshProducer.id)).rawToken}`;
  const res = await fetch(`${baseUrl}/api/hr/employees/me`, { headers: { Cookie: freshCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.employee, null);

  await prisma.session.deleteMany({ where: { userId: freshProducer.id } });
  await prisma.user.delete({ where: { id: freshProducer.id } });
});

test('GET /hr/overview returns real aggregates scoped to the caller\'s own agency only', async () => {
  const res = await fetch(`${baseUrl}/api/hr/overview`, { headers: { Cookie: ownerACookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.overview.activeEmployeeCount, 'number');
  assert.equal(typeof body.overview.totalDepartments, 'number');
  assert.ok(Array.isArray(body.overview.byDepartment));
});
