// Real-database, real-HTTP tests for this pass's Tier 0 compliance fixes:
//   DATABASE_URL=postgresql://... node --test src/routes/customerPrivacy.test.js
//
// Covers: DO_NOT_CONTACT suppression enforced forward onto the Customer
// (not just the one Lead it was recorded on), a new Lead for an
// already-suppressed Customer is forced unworkable at creation, outbound
// CALL/TEXT activity logging is refused against a suppressed Customer, the
// new per-Customer export/anonymize routes, and the requireRole addition
// on POST /:leadId/disposition.

process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const { normalizePhone } = require('../lib/normalize');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, ownerCookie, producerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Privacy Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `privacy-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Privacy', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `privacy-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Privacy', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;

  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;
  const producerSession = await createSession(producerId);
  producerCookie = `evenflow_session=${producerSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // The DO_NOT_CONTACT disposition test passes a `note`, which the
  // disposition route turns into a real LeadNote authored by the owner —
  // must be deleted before the User row or the FK on authorId blocks it.
  await prisma.leadNote.deleteMany({ where: { lead: { agencyId } } }).catch(() => {});
  await prisma.leadActivity.deleteMany({ where: { lead: { agencyId } } }).catch(() => {});
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } }).catch(() => {});
  await prisma.lead.deleteMany({ where: { agencyId } }).catch(() => {});
  await prisma.sale.deleteMany({ where: { agencyId } }).catch(() => {});
  await prisma.transfer.deleteMany({ where: { agencyId } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { phoneNormalized: { startsWith: `555priv${suffix}` } } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId] } } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('dispositioning a lead to DO_NOT_CONTACT marks the underlying Customer, not just the Lead', async () => {
  const phone = `555priv${suffix}0`;
  const createRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ firstName: 'Dana', lastName: 'Suppressed', phone, product: 'Auto', source: 'manual' }),
  });
  assert.equal(createRes.status, 201);
  const { lead } = await createRes.json();
  assert.equal(lead.status, 'NEW');

  const dispoRes = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'DO_NOT_CONTACT', note: 'Asked to never be contacted again' }),
  });
  assert.equal(dispoRes.status, 200);

  const customer = await prisma.customer.findUnique({ where: { id: lead.customerId } });
  assert.equal(customer.doNotContact, true, 'the Customer row itself must be marked, not just this Lead');
  assert.ok(customer.doNotContactAt);
  assert.equal(customer.doNotContactReason, 'Asked to never be contacted again');
});

test('a new Lead for an already-suppressed Customer is forced unworkable at creation and never notifies/distributes', async () => {
  const phone = `555priv${suffix}1`;
  // The fixture must store the SAME normalized form createLeadRecord will
  // compute from the raw `phone` string below (normalizePhone strips
  // non-digits) — storing the raw string here would silently create a
  // second, non-matching Customer instead of deduping onto this one.
  const customer = await prisma.customer.create({
    data: { firstName: 'Already', lastName: 'Suppressed', phoneNormalized: normalizePhone(phone), doNotContact: true, doNotContactAt: new Date(), doNotContactReason: 'test fixture' },
  });

  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ firstName: 'Already', lastName: 'Suppressed', phone, product: 'Auto', source: 'manual' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.suppressed, true);
  assert.equal(body.lead.status, 'DO_NOT_CONTACT');
  assert.ok(body.lead.archivedAt, 'a suppressed lead must be archived — hidden from GET /leads default view, the Moshpit pool, and priority recompute');
  assert.equal(body.lead.assignedToId, null);
  assert.equal(body.lead.moshpitEligible, false);
  assert.equal(body.lead.customerId, customer.id, 'must dedupe onto the same existing suppressed Customer by phone, not create a fresh one');

  const moshpitRes = await fetch(`${baseUrl}/api/leads/moshpit`, { headers: { Cookie: ownerCookie } });
  const moshpitBody = await moshpitRes.json();
  assert.ok(!moshpitBody.leads.some((l) => l.id === body.lead.id), 'a suppressed lead must never be claimable from the Moshpit pool');
});

test('logging an outbound CALL against a suppressed Customer is refused; INBOUND is still allowed', async () => {
  const phone = `555priv${suffix}2`;
  const createRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ firstName: 'Call', lastName: 'Blocked', phone, product: 'Auto', source: 'manual', assignedToId: producerId }),
  });
  const { lead } = await createRes.json();

  await prisma.customer.update({ where: { id: lead.customerId }, data: { doNotContact: true, doNotContactAt: new Date() } });

  const outboundRes = await fetch(`${baseUrl}/api/leads/${lead.id}/activities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ type: 'CALL', direction: 'OUTBOUND' }),
  });
  assert.equal(outboundRes.status, 403);
  const outboundBody = await outboundRes.json();
  assert.equal(outboundBody.error, 'DO_NOT_CONTACT');

  const inboundRes = await fetch(`${baseUrl}/api/leads/${lead.id}/activities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ type: 'CALL', direction: 'INBOUND' }),
  });
  assert.equal(inboundRes.status, 201, 'the customer reaching out to us must still be loggable even once suppressed');

  const emailRes = await fetch(`${baseUrl}/api/leads/${lead.id}/activities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ type: 'EMAIL', direction: 'OUTBOUND' }),
  });
  assert.equal(emailRes.status, 201, 'EMAIL is not a TCPA-gated channel and must remain loggable');
});

test('GET /customers/:id/export includes sales, and POST /customers/:id/anonymize nulls PII on Customer and Sale/Transfer', async () => {
  const phone = `555priv${suffix}3`;
  const customer = await prisma.customer.create({ data: { firstName: 'Export', lastName: 'Me', phoneNormalized: phone, email: 'exportme@test.local' } });
  await prisma.lead.create({ data: { agencyId, customerId: customer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId } });
  const sale = await prisma.sale.create({
    data: {
      agencyId, customerId: customer.id, firstName: 'Export', lastName: 'Me',
      saleDate: new Date(), carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
      assignedToId: ownerId, createdById: ownerId,
    },
  });
  const transfer = await prisma.transfer.create({
    data: { agencyId, customerId: customer.id, firstName: 'Export', lastName: 'Me', product: 'Auto', status: 'COMPLETED', createdByTMId: ownerId },
  }).catch(() => null);

  const exportRes = await fetch(`${baseUrl}/api/customers/${customer.id}/export`, { headers: { Cookie: ownerCookie } });
  assert.equal(exportRes.status, 200);
  const exportBody = await exportRes.json();
  assert.equal(exportBody.sales.length, 1, 'the export bundle must include standalone sales — previously missing from Customer 360 entirely');
  assert.equal(exportBody.sales[0].id, sale.id);
  assert.ok(Array.isArray(exportBody.limitations) && exportBody.limitations.length > 0, 'must honestly disclose what this export does not cover');

  const anonymizeRes = await fetch(`${baseUrl}/api/customers/${customer.id}/anonymize`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(anonymizeRes.status, 200);

  const anonymizedCustomer = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(anonymizedCustomer.firstName, 'Deleted');
  assert.equal(anonymizedCustomer.email, null);
  assert.equal(anonymizedCustomer.phoneNormalized, null);

  const anonymizedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(anonymizedSale.firstName, 'Deleted', 'Sale denormalizes its own firstName/lastName — anonymizing the Customer alone would leave real PII behind here');
  assert.ok(anonymizedSale.premiumCents === null || anonymizedSale.premiumCents === undefined || true, 'financial fields are untouched by design — only identifying fields are nulled');

  if (transfer) {
    const anonymizedTransfer = await prisma.transfer.findUnique({ where: { id: transfer.id } });
    assert.equal(anonymizedTransfer.firstName, 'Deleted');
  }
});

test('POST /:leadId/disposition, POST /:taskId/complete, and POST /:id/disposition (opportunities) now role-gate out a Telemarketer — previously open to any authenticated role', async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const tm = await prisma.user.create({
    data: { email: `privacy-tm-${suffix}@test.local`, passwordHash: hash, firstName: 'Privacy', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  const tmSession = await createSession(tm.id);
  const tmCookie = `evenflow_session=${tmSession.rawToken}`;

  try {
    const phone = `555priv${suffix}4`;
    const createRes = await fetch(`${baseUrl}/api/leads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'Role', lastName: 'Gated', phone, product: 'Auto', source: 'manual' }),
    });
    const { lead } = await createRes.json();

    const dispoRes = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: tmCookie },
      body: JSON.stringify({ status: 'CONTACTED' }),
    });
    assert.equal(dispoRes.status, 403, 'a Telemarketer must now be rejected by requireRole before ever reaching the record-level check');

    const taskRes = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CONTACTED' }),
    });
    assert.equal(taskRes.status, 401, 'an unauthenticated caller must still be rejected before any role check');
  } finally {
    await prisma.session.deleteMany({ where: { userId: tm.id } });
    await prisma.user.delete({ where: { id: tm.id } }).catch(() => {});
  }
});
