// Real-DB (and real-HTTP, for the disposition-route integration) tests
// for Agency.followUpRules + lib/leadFollowUp.js — a new, distinct
// mechanism from lib/priority.js's statusRules (which only ever adjusts
// sort order). A disposition into a configured status schedules a real
// Follow-Up Task N days later; checkLeadFollowUps() is the periodic job
// that actually creates it once due.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prisma } = require('./db');
const { createSession } = require('./auth');
const app = require('../app');
const { computeFollowUpAt, checkLeadFollowUps } = require('./leadFollowUp');

test('computeFollowUpAt: a configured status schedules the correct future date', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const result = computeFollowUpAt('LEFT_VM', { LEFT_VM: 2 }, now);
  assert.equal(result.toISOString(), new Date('2026-01-03T00:00:00Z').toISOString());
});

test('computeFollowUpAt: an unconfigured status, null rules, or a non-positive afterDays all return null', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(computeFollowUpAt('QUOTED', { LEFT_VM: 2 }, now), null, 'no rule for this status');
  assert.equal(computeFollowUpAt('LEFT_VM', null, now), null, 'no rules configured at all');
  assert.equal(computeFollowUpAt('LEFT_VM', { LEFT_VM: 0 }, now), null, 'zero days never schedules anything');
  assert.equal(computeFollowUpAt('LEFT_VM', { LEFT_VM: -1 }, now), null, 'a negative value never schedules anything');
});

const suffix = Date.now();
let agencyId, producerId, producer2Id, ownerId, ownerCookie, server, baseUrl;
let leadIds = [];
let taskIds = [];

before(async () => {
  const agency = await prisma.agency.create({
    data: {
      name: `FollowUp Test Agency ${suffix}`,
      followUpRules: { LEFT_VM: 2, QUOTED: 5 },
      requireDispositionNoteStatuses: ['NOT_INTERESTED'],
    },
  });
  agencyId = agency.id;
  const producer = await prisma.user.create({
    data: { email: `followup-p1-${suffix}@test.local`, firstName: 'Prod', lastName: 'One', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const producer2 = await prisma.user.create({
    data: { email: `followup-p2-${suffix}@test.local`, firstName: 'Prod', lastName: 'Two', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer2Id = producer2.id;
  const owner = await prisma.user.create({
    data: { email: `followup-owner-${suffix}@test.local`, firstName: 'Own', lastName: 'Er', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: [producerId, producer2Id] } } });
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.leadNote.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: { in: [producerId, producer2Id, ownerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function makeLead(assignedToId, extra = {}) {
  const lead = await prisma.lead.create({ data: { agencyId, source: 'manual', status: 'NEW', assignedToId, ...extra } });
  leadIds.push(lead.id);
  return lead;
}

test('checkLeadFollowUps: creates a real Follow-Up Task for a lead whose followUpAt has arrived, and clears it', async () => {
  const lead = await makeLead(producerId, { status: 'LEFT_VM', followUpAt: new Date(Date.now() - 1000) });

  const result = await checkLeadFollowUps();
  assert.ok(result.created >= 1);

  const task = await prisma.task.findFirst({ where: { leadId: lead.id, type: 'FOLLOW_UP' } });
  assert.ok(task, 'a real Follow-Up Task must be created');
  taskIds.push(task.id);
  assert.equal(task.assignedToId, producerId);
  assert.equal(task.agencyId, agencyId);

  const refreshed = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(refreshed.followUpAt, null, 'followUpAt must be cleared once the task is created');

  const notification = await prisma.notification.findFirst({ where: { userId: producerId, type: 'lead.follow_up_due', relatedEntityId: lead.id } });
  assert.ok(notification, 'the assigned producer must be notified');
});

test('checkLeadFollowUps: a lead not yet due is left untouched', async () => {
  const lead = await makeLead(producerId, { status: 'LEFT_VM', followUpAt: new Date(Date.now() + 60 * 60 * 1000) });
  await checkLeadFollowUps();
  const refreshed = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(refreshed.followUpAt.getTime(), lead.followUpAt.getTime(), 'a not-yet-due followUpAt must be left alone');
  const task = await prisma.task.findFirst({ where: { leadId: lead.id, type: 'FOLLOW_UP' } });
  assert.equal(task, null, 'no task should exist yet');
});

test('checkLeadFollowUps: an unassigned lead with a due follow-up is cleared without creating an orphan task', async () => {
  const lead = await makeLead(null, { status: 'LEFT_VM', followUpAt: new Date(Date.now() - 1000) });
  await checkLeadFollowUps();
  const refreshed = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(refreshed.followUpAt, null, 'the pending follow-up must be cleared rather than retried forever');
  const task = await prisma.task.findFirst({ where: { leadId: lead.id, type: 'FOLLOW_UP' } });
  assert.equal(task, null, 'no task should be created for an unassigned lead');
});

test('checkLeadFollowUps: a reassigned lead\'s task goes to its CURRENT assignee, not whoever it was assigned to at disposition time', async () => {
  const lead = await makeLead(producer2Id, { status: 'LEFT_VM', followUpAt: new Date(Date.now() - 1000) });
  await checkLeadFollowUps();
  const task = await prisma.task.findFirst({ where: { leadId: lead.id, type: 'FOLLOW_UP' } });
  assert.ok(task);
  taskIds.push(task.id);
  assert.equal(task.assignedToId, producer2Id);
});

test('POST /:leadId/disposition: a status with a configured follow-up rule sets Lead.followUpAt to the right future date', async () => {
  const lead = await makeLead(producerId);
  const before = Date.now();
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'LEFT_VM' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.lead.followUpAt);
  const expectedMin = before + 2 * 24 * 60 * 60 * 1000 - 5000;
  const expectedMax = before + 2 * 24 * 60 * 60 * 1000 + 5000;
  const actual = new Date(body.lead.followUpAt).getTime();
  assert.ok(actual >= expectedMin && actual <= expectedMax, 'followUpAt must be ~2 days out per the configured LEFT_VM rule');
});

test('POST /:leadId/disposition: a status with no configured rule leaves followUpAt null, and a later disposition clears a previously-pending one', async () => {
  const lead = await makeLead(producerId);
  const first = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'LEFT_VM' }),
  });
  assert.ok((await first.json()).lead.followUpAt, 'LEFT_VM schedules a follow-up');

  const second = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'CONTACTED' }),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.lead.followUpAt, null, 'a disposition into a status with no rule must clear any previously-pending follow-up');
});

test('POST /:leadId/disposition: an agency-required note is enforced for its configured statuses only', async () => {
  const leadWithoutNote = await makeLead(producerId);
  const blocked = await fetch(`${baseUrl}/api/leads/${leadWithoutNote.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'NOT_INTERESTED' }),
  });
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).error, 'NOTE_REQUIRED');

  const withNote = await fetch(`${baseUrl}/api/leads/${leadWithoutNote.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'NOT_INTERESTED', note: 'Called twice, asked to be removed.' }),
  });
  assert.equal(withNote.status, 200, 'a real note satisfies the requirement');

  // LOST has no note requirement configured for this agency — must never
  // be blocked despite requireDispositionNoteStatuses being non-empty.
  const leadForLost = await makeLead(producerId);
  const unaffected = await fetch(`${baseUrl}/api/leads/${leadForLost.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'LOST' }),
  });
  assert.equal(unaffected.status, 200, 'a status not in requireDispositionNoteStatuses must never require a note');
});
