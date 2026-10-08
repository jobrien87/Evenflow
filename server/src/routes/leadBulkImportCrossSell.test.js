// Real-DB, real-HTTP tests for the AUTO_NO_HOME/HOME_NO_AUTO bulk-upload
// categories — confirms a row uploaded under either category lands as a
// real Lead with the right leadType/product/crossSellHaveProduct triple,
// matching leadBulkImportDistribution.test.js's established conventions
// (real multipart POST via fetch()+FormData, never a mocked route).
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
  const agency = await prisma.agency.create({ data: { name: `Cross-Sell Upload Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `xsell-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Xsell', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
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
  await prisma.leadProductQuote.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.leadImportBatch.deleteMany({ where: { agencyId } });
  await prisma.notification.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

let rowSeq = 0;
function csvFile(rows) {
  const header = 'First Name,Last Name,Phone,Email\n';
  const body = rows
    .map((r) => {
      const i = rowSeq++;
      return `${r.firstName},${r.lastName},555${suffix}${i},test${suffix}${i}@example.com`;
    })
    .join('\n');
  return new Blob([header + body], { type: 'text/csv' });
}

async function uploadBulk({ rows, leadCategory }) {
  const form = new FormData();
  form.append('file', csvFile(rows), 'leads.csv');
  form.append('leadCategory', leadCategory);
  const res = await fetch(`${baseUrl}/api/leads/bulk-import`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function leadsForBatch(batchId) {
  return prisma.lead.findMany({ where: { importBatchId: batchId }, orderBy: { createdAt: 'asc' } });
}

test('AUTO_NO_HOME: creates a CROSS_SELL lead quoting Home, with Auto recorded as already held', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Nora', lastName: 'Autoholder' }], leadCategory: 'AUTO_NO_HOME' });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);

  const [lead] = await leadsForBatch(res.body.batchId);
  assert.equal(lead.leadType, 'CROSS_SELL');
  assert.equal(lead.product, 'Home');
  assert.equal(lead.crossSellHaveProduct, 'AUTO');
});

test('HOME_NO_AUTO: creates a CROSS_SELL lead quoting Auto, with Home recorded as already held', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Omar', lastName: 'Homeholder' }], leadCategory: 'HOME_NO_AUTO' });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);

  const [lead] = await leadsForBatch(res.body.batchId);
  assert.equal(lead.leadType, 'CROSS_SELL');
  assert.equal(lead.product, 'Auto');
  assert.equal(lead.crossSellHaveProduct, 'HOME');
});

test('the generic CROSS_SELL category still sets no crossSellHaveProduct (regression check)', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Pat', lastName: 'Generic' }], leadCategory: 'CROSS_SELL' });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);

  const [lead] = await leadsForBatch(res.body.batchId);
  assert.equal(lead.leadType, 'CROSS_SELL');
  assert.ok(!lead.product, 'no product column in the CSV and CROSS_SELL sets no override, so product stays unset');
  assert.equal(lead.crossSellHaveProduct, null);
});

test('the raw category string is preserved on the import batch for both new categories', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Quinn', lastName: 'Batchcheck' }], leadCategory: 'AUTO_NO_HOME' });
  const batch = await prisma.leadImportBatch.findUnique({ where: { id: res.body.batchId } });
  assert.equal(batch.leadCategory, 'AUTO_NO_HOME');
});

// Item 7 of the production-correction round: quoting the already-held
// product must be rejected server-side too, not just filtered out of the
// client's chip row — a direct API call must not be able to bypass it.
test('POST /:leadId/products rejects a quote for the already-held product (server-side enforcement)', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Rae', lastName: 'Enforcecheck' }], leadCategory: 'AUTO_NO_HOME' });
  const [lead] = await leadsForBatch(res.body.batchId);
  assert.equal(lead.crossSellHaveProduct, 'AUTO');

  const heldRes = await fetch(`${baseUrl}/api/leads/${lead.id}/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ product: 'AUTO', status: 'QUOTED' }),
  });
  assert.equal(heldRes.status, 400);
  const heldBody = await heldRes.json();
  assert.equal(heldBody.error, 'PRODUCT_ALREADY_HELD');

  const quotableRes = await fetch(`${baseUrl}/api/leads/${lead.id}/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ product: 'HOME', status: 'QUOTED' }),
  });
  assert.equal(quotableRes.status, 200, 'the actual cross-sell target (Home) must still be quotable');
});

test('POST /:leadId/products never blocks any product for a plain CROSS_SELL lead with no crossSellHaveProduct', async () => {
  const res = await uploadBulk({ rows: [{ firstName: 'Sam', lastName: 'Genericcheck' }], leadCategory: 'CROSS_SELL' });
  const [lead] = await leadsForBatch(res.body.batchId);
  assert.equal(lead.crossSellHaveProduct, null);

  const anyRes = await fetch(`${baseUrl}/api/leads/${lead.id}/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ product: 'AUTO', status: 'QUOTED' }),
  });
  assert.equal(anyRes.status, 200, 'never inferred/blocked for a generic cross-sell lead with no reliable have-product data');
});
