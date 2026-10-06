// Real-DB, real-HTTP test confirming Part 7's "never lose a column" fix:
// a bulk/back-catalog lead import captures the FULL original spreadsheet
// row — recognized columns and unmatched ones alike — into the new,
// separate Lead.rawImportFields column, while every other creation path
// (manual, vendor API) leaves it null.
process.env.NODE_ENV = 'development';

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
  const agency = await prisma.agency.create({ data: { name: `Raw Import Fields Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `rif-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Raw', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
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

test('a bulk-import lead keeps its full original row, unmatched columns included, in rawImportFields', async () => {
  // This CSV has columns the AI fallback would otherwise try to map (never
  // a real network call in a test run) — force the honest "not configured"
  // path regardless of this sandbox's own .env, matching
  // historicalDataImport.test.js's own save/restore convention.
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let body;
  try {
    const csv = `First Name,Last Name,Phone,Email,Policy #,Prior Company\nAda,Lovelace,555${suffix}1,ada${suffix}@example.com,POL-77,Acme Insurance`;
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'leads.csv');
    form.append('leadCategory', 'INTERNET');
    form.append('distributionMode', 'MOSHPIT');
    const res = await fetch(`${baseUrl}/api/leads/bulk-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.ok(body.columnMapping, 'the response must surface a columnMapping block');
    assert.equal(body.columnMapping.aiUsed, false);
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  }

  const lead = await prisma.lead.findFirst({ where: { importBatchId: body.batchId }, include: { customer: true } });
  assert.ok(lead);
  assert.equal(lead.rawImportFields['First Name'], 'Ada');
  assert.equal(lead.rawImportFields['Policy #'], 'POL-77', 'a column with no recognized field must still be captured losslessly');
  assert.equal(lead.rawImportFields['Prior Company'], 'Acme Insurance');
  assert.equal(lead.customFields === null || typeof lead.customFields === 'object', true);
});

test('a manually-created lead never gets rawImportFields populated', async () => {
  const res = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ firstName: 'Manual', lastName: 'Lead', phone: `555${suffix}9`, product: 'Auto' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const lead = await prisma.lead.findUnique({ where: { id: body.lead.id } });
  assert.equal(lead.rawImportFields, null);
});
