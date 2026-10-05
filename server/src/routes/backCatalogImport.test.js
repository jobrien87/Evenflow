// Real-DB, real-HTTP tests for the "Back Catalog" historical import route
// (POST /leads/back-catalog-import) — porting leads/customers in from
// Performology/AgencyZoom/Ricochet/other legacy systems. Unlike the live
// POST /leads/bulk-import, this path must always land leads unassigned and
// NOT Moshpit-eligible (no distribution, no live routing), must never send
// a notification, and must never trust a source file's own status column
// as Lead.status — it only logs it as creation-event metadata. Reuses the
// exact same fetch()+FormData+Blob multipart pattern as
// leadBulkImportDistribution.test.js.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, server, port, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Back Catalog Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `back-catalog-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Cat', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const { rawToken } = await createSession(ownerId);
  ownerCookie = `evenflow_session=${rawToken}`;

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
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

let rowSeq = 0;
function csvFile(rows, { includeStatus = false } = {}) {
  const header = includeStatus ? 'First Name,Last Name,Phone,Email,Status\n' : 'First Name,Last Name,Phone,Email\n';
  const body = rows
    .map((r) => {
      const i = rowSeq++;
      // The phone, not just the email, must be unique PER TEST RUN (include
      // suffix) — createLeadRecord's duplicate-customer detection is global
      // across agencies and keyed on phone/email, so a phone that's only
      // unique within one process run collides with a leftover Customer row
      // from any earlier run of this same file and silently flips the new
      // lead's creation-event type to 'lead.created.possible_duplicate'.
      const base = `${r.firstName},${r.lastName},555${suffix}${i},backcat${suffix}${i}@example.com`;
      return includeStatus ? `${base},${r.status || ''}` : base;
    })
    .join('\n');
  return new Blob([header + body], { type: 'text/csv' });
}

async function uploadBackCatalog({ rows, sourceSystem = 'AGENCYZOOM', leadCategory = 'INTERNET', includeStatus = false }) {
  const form = new FormData();
  form.append('file', csvFile(rows, { includeStatus }), 'export.csv');
  form.append('sourceSystem', sourceSystem);
  form.append('leadCategory', leadCategory);

  const res = await fetch(`${baseUrl}/api/leads/back-catalog-import`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('rejects an unrecognized sourceSystem before creating anything', async () => {
  const res = await uploadBackCatalog({ rows: [{ firstName: 'A', lastName: 'One' }], sourceSystem: 'NOT_A_REAL_SYSTEM' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('ported leads land unassigned, NOT Moshpit-eligible, tagged with sourceSystem, and send zero notifications', async () => {
  const before_ = await prisma.notification.count({ where: { agencyId } });
  const res = await uploadBackCatalog({
    rows: [{ firstName: 'Pat', lastName: 'Historical' }, { firstName: 'Sam', lastName: 'Legacy' }],
    sourceSystem: 'PERFORMOLOGY',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sourceSystem, 'PERFORMOLOGY');
  assert.equal(res.body.created, 2);

  const leads = await prisma.lead.findMany({ where: { importBatchId: res.body.batchId } });
  assert.equal(leads.length, 2);
  for (const lead of leads) {
    assert.equal(lead.assignedToId, null, 'back-catalog leads must never be auto-assigned');
    assert.equal(lead.moshpitEligible, false, 'back-catalog leads must never be dropped into the Moshpit pool');
    assert.equal(lead.status, 'NEW');
    assert.equal(lead.source, 'backcatalog_performology');
  }

  const batch = await prisma.leadImportBatch.findUnique({ where: { id: res.body.batchId } });
  assert.equal(batch.sourceSystem, 'PERFORMOLOGY');

  const after_ = await prisma.notification.count({ where: { agencyId } });
  assert.equal(after_, before_, 'a historical backfill import must never notify anyone');
});

test('a source file\'s own status column is recorded as event metadata, never written to Lead.status', async () => {
  const res = await uploadBackCatalog({
    rows: [{ firstName: 'Rio', lastName: 'Ported', status: 'Policy Lapsed' }],
    sourceSystem: 'RICOCHET',
    includeStatus: true,
  });
  assert.equal(res.status, 200);
  const lead = await prisma.lead.findFirst({ where: { importBatchId: res.body.batchId } });
  assert.equal(lead.status, 'NEW', 'a source status/disposition must never set live Lead.status');

  const event = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'lead.created' } });
  assert.equal(event.metadata.externalStatus, 'Policy Lapsed');
});

test('GET /leads/import-batches?kind=back_catalog returns only back-catalog batches; the default list excludes them', async () => {
  const backCatalogRes = await fetch(`${baseUrl}/api/leads/import-batches?kind=back_catalog`, { headers: { Cookie: ownerCookie } });
  const backCatalogBody = await backCatalogRes.json();
  assert.ok(backCatalogBody.batches.length >= 2);
  for (const b of backCatalogBody.batches) assert.ok(b.sourceSystem, 'every row in the back-catalog list must have a sourceSystem');

  const defaultRes = await fetch(`${baseUrl}/api/leads/import-batches`, { headers: { Cookie: ownerCookie } });
  const defaultBody = await defaultRes.json();
  for (const b of defaultBody.batches) assert.equal(b.sourceSystem, null, 'the ordinary bulk-upload history must never include a back-catalog batch');
});

test('undo still works generically on a back-catalog batch via the existing undo route', async () => {
  const res = await uploadBackCatalog({ rows: [{ firstName: 'Undo', lastName: 'Me' }], sourceSystem: 'OTHER' });
  assert.equal(res.status, 200);

  const undoRes = await fetch(`${baseUrl}/api/leads/import-batches/${res.body.batchId}/undo`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(undoRes.status, 200);

  const lead = await prisma.lead.findFirst({ where: { importBatchId: res.body.batchId } });
  assert.ok(lead.archivedAt, 'undo must archive the back-catalog lead the same way it archives a live bulk-import lead');
});
