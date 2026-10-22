// decideChanges is pure (no I/O) — the bulk of this file tests it
// directly against hand-built performance data. The remaining tests cover
// the real end-to-end pipeline (runOptimizationForSubscription) against
// a real Lead/Sale/RecordStoreSubscription set, with lib/boberdoo.js
// monkey-patched per scenario like recordStoreProvisioning.test.js does.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const boberdoo = require('./boberdoo');
const { decideChanges, runOptimizationForSubscription, runSourceOptimizationSweep, WINDOW_DAYS } = require('./recordStoreSourceOptimization');

const originalBoberdoo = { ...boberdoo };
function resetBoberdoo() { Object.assign(boberdoo, originalBoberdoo); }

// ---- decideChanges (pure) -------------------------------------------------

function row({ sourceCode, closeRate, leadCount, hasMinimumSample = true }) {
  return { sourceCode, label: `EvenFlow ${sourceCode}`, closeRate, leadCount, hasMinimumSample };
}

test('decideChanges: fewer than 2 sources with enough data -> no change', () => {
  const zero = decideChanges({ perSource: [], currentSources: ['A', 'B'], minimumSampleSize: 10 });
  assert.equal(zero.changed, false);

  const one = decideChanges({
    perSource: [row({ sourceCode: 'A', closeRate: 40, leadCount: 20 })],
    currentSources: ['A', 'B'],
    minimumSampleSize: 10,
  });
  assert.equal(one.changed, false);
});

test('decideChanges: a source well below the best is dropped, and the best is never dropped', () => {
  const perSource = [
    row({ sourceCode: 'A', closeRate: 40, leadCount: 20 }),
    row({ sourceCode: 'B', closeRate: 5, leadCount: 25 }),
  ];
  const decision = decideChanges({ perSource, currentSources: ['A', 'B'], minimumSampleSize: 10 });
  assert.equal(decision.changed, true);
  assert.deepEqual(decision.droppedSources, ['B']);
  assert.deepEqual(decision.newSources, ['A']);
  assert.match(decision.reasoning, /EvenFlow B/);
  assert.match(decision.reasoning, /EvenFlow A/);
});

test('decideChanges: sources within range of each other -> no change', () => {
  const perSource = [
    row({ sourceCode: 'A', closeRate: 40, leadCount: 20 }),
    row({ sourceCode: 'B', closeRate: 30, leadCount: 20 }),
  ];
  const decision = decideChanges({ perSource, currentSources: ['A', 'B'], minimumSampleSize: 10 });
  assert.equal(decision.changed, false);
});

test('decideChanges: never drops below one source even if every eligible source is equally bad', () => {
  const perSource = [
    row({ sourceCode: 'A', closeRate: 2, leadCount: 20 }),
    row({ sourceCode: 'B', closeRate: 2, leadCount: 20 }),
  ];
  const decision = decideChanges({ perSource, currentSources: ['A', 'B'], minimumSampleSize: 10 });
  // Both tie for "best" at index 0 after sort; B is compared against A (the
  // first/best) and 2 <= 2*0.5=1 is false, so nothing is dropped here —
  // the real guard against an all-zero close rate is the dedicated test below.
  assert.equal(decision.changed, false);
});

test('decideChanges: a 0% best close rate never drives a drop (nothing to compare favorably against)', () => {
  const perSource = [
    row({ sourceCode: 'A', closeRate: 0, leadCount: 20 }),
    row({ sourceCode: 'B', closeRate: 0, leadCount: 20 }),
  ];
  const decision = decideChanges({ perSource, currentSources: ['A', 'B'], minimumSampleSize: 10 });
  assert.equal(decision.changed, false);
});

test('decideChanges: a source not in currentSources (e.g. already dropped, still has historical leads) is ignored', () => {
  const perSource = [
    row({ sourceCode: 'A', closeRate: 40, leadCount: 20 }),
    row({ sourceCode: 'STALE', closeRate: 1, leadCount: 20 }),
  ];
  const decision = decideChanges({ perSource, currentSources: ['A'], minimumSampleSize: 10 });
  assert.equal(decision.changed, false, 'only one currently-accepted source has enough data; nothing to compare it against');
});

// ---- Real end-to-end pipeline ---------------------------------------------

const suffix = Date.now();
let agencyId, customerId, userId, templateId, subscriptionId;
const leadIds = [];
const saleIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Source Opt Test Agency ${suffix}`, boberdooPartnerId: `PARTNER-OPT-${suffix}` } });
  agencyId = agency.id;
  const bcrypt = require('bcryptjs');
  const user = await prisma.user.create({
    data: { email: `opt-user-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Opt', lastName: 'Agent', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  userId = user.id;
  const customer = await prisma.customer.create({ data: { firstName: 'Opt', lastName: 'Test', email: `opt-${suffix}@test.local` } });
  customerId = customer.id;
  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_OPT_TEMPLATE_${suffix}`, displayName: 'Test Opt Template', productCategory: 'AUTO', leadType: 'INTERNET' },
  });
  templateId = template.id;
});

beforeEach(() => { resetBoberdoo(); });

after(async () => {
  // Every test in this block creates its own fresh subscription (so prior
  // runs never bleed into the next), each leaving its own history rows —
  // clean up by agency, not just the last subscriptionId.
  await prisma.recordStoreSourceOptimization.deleteMany({ where: { subscription: { agencyId } } });
  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.recordStoreTemplate.delete({ where: { id: templateId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

// sold: true creates a real Sale row (the only thing computeSourcePerformance
// actually counts as "closed" — a Lead.status of 'SOLD' alone is never
// trusted, same discipline lib/vendorReport.js follows).
async function makeLead({ sourceCode, status, sold }) {
  const lead = await prisma.lead.create({
    data: {
      agencyId, customerId, source: 'record_store:boberdoo', product: 'Auto', status,
      leadType: 'DATA_LEAD', recordStoreSourceCode: sourceCode, recordStoreSubscriptionId: subscriptionId,
    },
  });
  leadIds.push(lead.id);
  if (sold) {
    const sale = await prisma.sale.create({
      data: {
        agencyId, customerId, leadId: lead.id, firstName: 'Opt', lastName: 'Test', saleDate: new Date(),
        premiumCents: 10000, productFamily: 'Auto', carrier: 'Test Carrier', policyType: 'Standard',
        assignedToId: userId, createdById: userId,
      },
    });
    saleIds.push(sale.id);
  }
  return lead;
}

async function freshSubscription() {
  const sub = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: templateId, productNameSnapshot: 'Test Opt Template',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 500, dailyVolume: 50,
      status: 'ACTIVE', boberdooPartnerId: `PARTNER-OPT-${suffix}`, boberdooFilterSetId: `FS-OPT-${Date.now()}`,
      customConfigurationJson: { Accepted_Sources: 'opt-good,opt-bad' },
    },
  });
  subscriptionId = sub.id;
  return sub;
}

test('runOptimizationForSubscription: real underperformance applies a real Boberdoo update and records history', async () => {
  const sub = await freshSubscription();
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-good', status: i < 6 ? 'SOLD' : 'QUOTED', sold: i < 6 });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-bad', status: 'NEW' });

  let sentFields = null;
  boberdoo.updateFilterSet = async (filterSetId, partnerId, fields) => {
    sentFields = fields;
    return { success: true };
  };

  await runOptimizationForSubscription({ ...sub, template: { configurationJson: {}, isIpr: false, filterSetType: 'STANDARD' } });

  assert.ok(sentFields, 'a real filter-set update must have been sent');
  assert.equal(sentFields.Accepted_Sources, 'opt-good');

  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId } });
  assert.equal(updated.customConfigurationJson.Accepted_Sources, 'opt-good');
  assert.ok(updated.lastSourceOptimizationAt);

  const history = await prisma.recordStoreSourceOptimization.findMany({ where: { recordStoreSubscriptionId: subscriptionId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'APPLIED');
  assert.deepEqual(history[0].droppedSources, ['opt-bad']);
});

test('runOptimizationForSubscription: a Boberdoo failure never changes the stored Accepted_Sources, but still records FAILED history', async () => {
  const sub = await freshSubscription();
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-good', status: i < 6 ? 'SOLD' : 'QUOTED', sold: i < 6 });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-bad', status: 'NEW' });

  boberdoo.updateFilterSet = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'boom' });

  await runOptimizationForSubscription({ ...sub, template: { configurationJson: {}, isIpr: false, filterSetType: 'STANDARD' } });

  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId } });
  assert.equal(updated.customConfigurationJson.Accepted_Sources, 'opt-good,opt-bad', 'local state must stay exactly as it was on a failed apply');
  assert.ok(updated.lastSourceOptimizationAt, 'the clock still advances even on a failed apply, so it is retried in 30 days, not forever');

  const history = await prisma.recordStoreSourceOptimization.findMany({ where: { recordStoreSubscriptionId: subscriptionId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'FAILED');
  assert.ok(history[0].errorMessage);
});

test('runOptimizationForSubscription: not enough data yet records SKIPPED_NO_CHANGE and never calls Boberdoo', async () => {
  const sub = await freshSubscription();
  await makeLead({ sourceCode: 'opt-good', status: 'NEW' });

  let called = false;
  boberdoo.updateFilterSet = async () => { called = true; return { success: true }; };

  await runOptimizationForSubscription({ ...sub, template: { configurationJson: {}, isIpr: false, filterSetType: 'STANDARD' } });

  assert.equal(called, false);
  const history = await prisma.recordStoreSourceOptimization.findMany({ where: { recordStoreSubscriptionId: subscriptionId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'SKIPPED_NO_CHANGE');
});

test('runSourceOptimizationSweep: a subscription with autoOptimizeSources off is never touched', async () => {
  const sub = await freshSubscription();
  await prisma.recordStoreSubscription.update({
    where: { id: sub.id },
    data: { autoOptimizeSources: false, startedAt: new Date(Date.now() - (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000) },
  });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-good', status: 'SOLD' });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-bad', status: 'NEW' });

  let called = false;
  boberdoo.updateFilterSet = async () => { called = true; return { success: true }; };

  await runSourceOptimizationSweep();

  assert.equal(called, false);
  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(updated.lastSourceOptimizationAt, null, 'an opted-out subscription is never evaluated, so its clock never advances either');
});

test('runSourceOptimizationSweep: a subscription still within its first 30 days is not due yet', async () => {
  const sub = await freshSubscription();
  await prisma.recordStoreSubscription.update({
    where: { id: sub.id },
    data: { startedAt: new Date() }, // just started
  });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-good', status: 'SOLD' });
  for (let i = 0; i < 12; i++) await makeLead({ sourceCode: 'opt-bad', status: 'NEW' });

  let called = false;
  boberdoo.updateFilterSet = async () => { called = true; return { success: true }; };

  await runSourceOptimizationSweep();

  assert.equal(called, false);
});
