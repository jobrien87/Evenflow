// Real-database, real-HTTP test for GET /api/work-queue's active-lead
// status filter — confirms every non-terminal LeadStatus stays in the
// queue (the bug: LEFT_VM, APPOINTMENT, and QUOTED_HOT were all missing
// from the old hand-rolled status array, so a lead in any of those
// statuses silently vanished from "what should I do next").
//   DATABASE_URL=postgresql://... node --test src/routes/workqueue.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, producerId, producerCookie, server, baseUrl;
let leadIds = [];
let customerIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `WorkQueue Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const producer = await prisma.user.create({
    data: { email: `wq-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'WQ', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const session = await createSession(producerId);
  producerCookie = `evenflow_session=${session.rawToken}`;

  async function makeLead(status) {
    const c = await prisma.customer.create({ data: { firstName: 'WQ', lastName: `${status}${suffix}` } });
    customerIds.push(c.id);
    const lead = await prisma.lead.create({
      data: { agencyId, customerId: c.id, source: 'manual', status, product: 'Auto', createdById: producerId, assignedToId: producerId },
    });
    leadIds.push(lead.id);
    return lead;
  }

  await Promise.all([
    makeLead('NEW'), makeLead('CONTACTED'), makeLead('LEFT_VM'), makeLead('APPOINTMENT'),
    makeLead('QUOTED'), makeLead('QUOTED_HOT'), makeLead('FOLLOW_UP'),
    makeLead('SOLD'), makeLead('LOST'), makeLead('NOT_INTERESTED'), makeLead('INELIGIBLE'),
  ]);

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.session.deleteMany({ where: { userId: producerId } });
  await prisma.user.delete({ where: { id: producerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('every non-terminal status stays in the work queue; SOLD/LOST/NOT_INTERESTED/INELIGIBLE never appear', async () => {
  const res = await fetch(`${baseUrl}/api/work-queue`, { headers: { Cookie: producerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const statuses = body.queue.filter((i) => i.itemType === 'LEAD').map((i) => i.status);

  for (const active of ['NEW', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT', 'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP']) {
    assert.ok(statuses.includes(active), `${active} must still appear in the work queue`);
  }
  for (const terminal of ['SOLD', 'LOST', 'NOT_INTERESTED', 'INELIGIBLE']) {
    assert.equal(statuses.includes(terminal), false, `${terminal} must never appear in the active work queue`);
  }
});
