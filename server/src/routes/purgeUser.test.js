// Real-database, real-HTTP test for Purge Deactivated User (preview + confirm)
// — DATABASE_URL=postgresql://... node --test src/routes/purgeUser.test.js
//
// Covers: a clean deactivated account (no recorded history) purges fully and
// disappears from the roster; a deactivated account WITH real history (a
// LeadNote in this case) is blocked, with the preview naming what's blocking
// it, and nothing is deleted; an ACTIVE account can't be purged at all; the
// type-the-email confirm guard; optional-FK rows (a Lead this user was
// assigned to) survive with the reference nulled out, not deleted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Purge Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `purge-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Purge', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function makeDeactivatedUser(label) {
  const hash = await bcrypt.hash('TestPass123!', 12);
  return prisma.user.create({
    data: {
      email: `purge-${label}-${suffix}@test.local`, passwordHash: hash,
      firstName: 'Clean', lastName: label, role: 'PRODUCER', agencyId,
      status: 'DEACTIVATED', deactivatedAt: new Date(),
    },
  });
}

test('purge-preview refuses an ACTIVE account', async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const activeProducer = await prisma.user.create({
    data: { email: `purge-active-${suffix}@test.local`, passwordHash: hash, firstName: 'Still', lastName: 'Active', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  const res = await fetch(`${baseUrl}/api/users/${activeProducer.id}/purge-preview`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'NOT_DEACTIVATED');
  await prisma.user.delete({ where: { id: activeProducer.id } });
});

test('a deactivated account with zero recorded history can be purged fully', async () => {
  const target = await makeDeactivatedUser('clean');

  const previewRes = await fetch(`${baseUrl}/api/users/${target.id}/purge-preview`, { headers: { Cookie: ownerCookie } });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.canPurge, true);
  assert.equal(Object.values(preview.blockers).every((n) => n === 0), true);

  const mismatchRes = await fetch(`${baseUrl}/api/users/${target.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: 'not-the-email' }),
  });
  assert.equal(mismatchRes.status, 400);
  assert.equal((await mismatchRes.json()).error, 'CONFIRMATION_MISMATCH');

  const deleteRes = await fetch(`${baseUrl}/api/users/${target.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: target.email }),
  });
  assert.equal(deleteRes.status, 200);

  const stillThere = await prisma.user.findUnique({ where: { id: target.id } });
  assert.equal(stillThere, null, 'the user row must be gone');
});

test('a deactivated account with real recorded history (a LeadNote) is blocked, not purged', async () => {
  const target = await makeDeactivatedUser('withhistory');
  const customer = await prisma.customer.create({ data: { firstName: 'Purge', lastName: 'Cust', phoneNormalized: `purgetest${suffix}` } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: target.id },
  });
  const note = await prisma.leadNote.create({ data: { leadId: lead.id, authorId: target.id, content: 'a real note this producer left' } });

  const previewRes = await fetch(`${baseUrl}/api/users/${target.id}/purge-preview`, { headers: { Cookie: ownerCookie } });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.canPurge, false);
  assert.equal(preview.blockers.leadNotes, 1, 'the preview must name the LeadNote as a blocker');

  const deleteRes = await fetch(`${baseUrl}/api/users/${target.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: target.email }),
  });
  assert.equal(deleteRes.status, 409, 'the server must re-check and refuse even with the right confirmText');
  assert.equal((await deleteRes.json()).error, 'HAS_RECORDED_HISTORY');

  const stillThere = await prisma.user.findUnique({ where: { id: target.id } });
  assert.ok(stillThere, 'the user row must survive a blocked purge attempt');

  // The Lead this user was ASSIGNED to (an optional FK, not a blocker) must
  // still have survived this same scenario -- confirms the assignedToId
  // path is correct even on a target that ultimately couldn't be purged.
  const leadStillThere = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.ok(leadStillThere, 'the Lead itself must never be touched by a purge attempt');

  await prisma.leadNote.delete({ where: { id: note.id } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
  await prisma.user.delete({ where: { id: target.id } });
});

test('purging a user who was only ASSIGNED a lead (optional FK) nulls the reference and keeps the Lead', async () => {
  const target = await makeDeactivatedUser('assignedonly');
  const customer = await prisma.customer.create({ data: { firstName: 'Purge', lastName: 'Cust2', phoneNormalized: `purgetest2${suffix}` } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: target.id },
  });

  const previewRes = await fetch(`${baseUrl}/api/users/${target.id}/purge-preview`, { headers: { Cookie: ownerCookie } });
  const preview = await previewRes.json();
  assert.equal(preview.canPurge, true, 'being merely assigned a lead is not a blocker -- only authored content is');

  const deleteRes = await fetch(`${baseUrl}/api/users/${target.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: target.email }),
  });
  assert.equal(deleteRes.status, 200);

  const [userGone, leadAfter] = await Promise.all([
    prisma.user.findUnique({ where: { id: target.id } }),
    prisma.lead.findUnique({ where: { id: lead.id } }),
  ]);
  assert.equal(userGone, null);
  assert.ok(leadAfter, 'the Lead row itself must survive');
  assert.equal(leadAfter.assignedToId, null, 'assignedToId must be nulled, not left dangling');

  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
});
