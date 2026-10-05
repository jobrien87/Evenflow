// Real-DB, real-HTTP regression tests for POST /leads/import-batches/:id/undo
// (Issue 10 of the hardening brief: "make bulk-import undo persistent and
// race-safe"). Two distinct races are covered here, matching this app's
// established convention of real concurrent calls over mocked timing (see
// recordStoreProvisioning.test.js's two-concurrent-createOrder test):
//
// 1. Double-undo — two concurrent requests for the same batch must not both
//    succeed (an atomic claim on LeadImportBatch.undoneAt).
// 2. Lost real work — a lead that real agency/producer action has touched
//    must never be archived by undo, even though the "which leads are still
//    untouched" read and the archiving write are two separate steps; the
//    archiving write re-asserts the untouched predicate itself.
//
// Persistence (GET /leads/import-batches surviving a page navigation, since
// it reads real LeadImportBatch rows rather than client-held React state)
// is also covered here at the route level — the client wiring is verified
// separately via a real browser pass.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, server, port, cookie;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Bulk Undo Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `bulk-undo-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Undo', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const { rawToken } = await createSession(ownerId);
  cookie = `evenflow_session=${rawToken}`;

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } });
  await prisma.leadNote.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.leadImportBatch.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, path, method,
        headers: {
          Connection: 'close', Cookie: cookie,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeBatch(leadCount) {
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: ownerId, leadCategory: 'INTERNET', totalRows: leadCount, created: leadCount, skipped: 0 },
  });
  const leads = [];
  for (let i = 0; i < leadCount; i += 1) {
    leads.push(await prisma.lead.create({ data: { agencyId, importBatchId: batch.id, status: 'NEW' } }));
  }
  return { batch, leads };
}

test('GET /leads/import-batches persists across requests — not tied to any one client session\'s local state', async () => {
  const { batch } = await makeBatch(2);
  const res = await request('GET', '/api/leads/import-batches');
  assert.equal(res.status, 200);
  const found = res.body.batches.find((b) => b.id === batch.id);
  assert.ok(found, 'a fresh, unrelated request must still see the batch — it is read from the DB, not held in any page\'s React state');
  assert.equal(found.undoableCount, 2);
  assert.equal(found.withinUndoWindow, true);
});

test('undo archives only leads untouched since import, preserving one that has already been worked', async () => {
  const { batch, leads } = await makeBatch(3);
  // Simulate real work landing on one lead before undo is ever called —
  // the straightforward, non-concurrent case the untouched-predicate must
  // still get right.
  await prisma.leadNote.create({ data: { leadId: leads[0].id, authorId: ownerId, content: 'Already called this one.' } });

  const res = await request('POST', `/api/leads/import-batches/${batch.id}/undo`);
  assert.equal(res.status, 200);
  assert.equal(res.body.archived, 2);
  assert.equal(res.body.kept, 1);

  const touched = await prisma.lead.findUnique({ where: { id: leads[0].id } });
  assert.equal(touched.archivedAt, null, 'a lead with real work on it must never be archived by undo');
  const untouched1 = await prisma.lead.findUnique({ where: { id: leads[1].id } });
  const untouched2 = await prisma.lead.findUnique({ where: { id: leads[2].id } });
  assert.ok(untouched1.archivedAt);
  assert.ok(untouched2.archivedAt);
});

test('a lead touched concurrently with undo is never lost — the archiving write re-checks state at write time, not a stale snapshot', async () => {
  const { batch, leads } = await makeBatch(1);
  // Fire the undo call and a real concurrent write that "touches" the one
  // lead in this batch at the same time — both real, separate async
  // operations racing against each other, same style as
  // recordStoreProvisioning.test.js's concurrent-createOrder test. Under
  // the old code (archive leads found by an earlier SELECT with no
  // further condition on the later UPDATE) this lead could be archived
  // regardless of which operation's effects "won" the race. Under the
  // fix, the two outcomes are mutually exclusive by construction: if the
  // assignment commits, the archiving updateMany's own WHERE no longer
  // matches that row.
  const [, assignResult] = await Promise.all([
    request('POST', `/api/leads/import-batches/${batch.id}/undo`),
    prisma.lead.update({ where: { id: leads[0].id }, data: { assignedToId: ownerId, assignedAt: new Date() } }).catch((err) => err),
  ]);

  const final = await prisma.lead.findUnique({ where: { id: leads[0].id } });
  if (!(assignResult instanceof Error) && final.assignedToId) {
    assert.equal(final.archivedAt, null, 'the assignment that landed must not have been silently overwritten by undo archiving this lead');
  } else {
    // The assignment write lost the race entirely (ran and committed
    // before undo's own read) — then undo correctly archived it, which is
    // fine, just a different interleaving of the same safe outcome.
    assert.ok(final.archivedAt || final.assignedToId);
  }
});

test('two concurrent undo requests for the same batch: exactly one actually archives, the other reports ALREADY_UNDONE', async () => {
  const { batch } = await makeBatch(4);

  const [res1, res2] = await Promise.all([
    request('POST', `/api/leads/import-batches/${batch.id}/undo`),
    request('POST', `/api/leads/import-batches/${batch.id}/undo`),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = res1.status === 200 ? res1 : res2;
  const loser = res1.status === 200 ? res2 : res1;
  assert.equal(winner.body.archived, 4);
  assert.equal(loser.body.error, 'ALREADY_UNDONE');

  const archivedCount = await prisma.lead.count({ where: { importBatchId: batch.id, archivedAt: { not: null } } });
  assert.equal(archivedCount, 4, 'the batch must be archived exactly once, not double-processed');
});

test('undo on an already-undone batch reports ALREADY_UNDONE and makes no further changes', async () => {
  const { batch } = await makeBatch(2);
  const first = await request('POST', `/api/leads/import-batches/${batch.id}/undo`);
  assert.equal(first.status, 200);

  const second = await request('POST', `/api/leads/import-batches/${batch.id}/undo`);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'ALREADY_UNDONE');
});
