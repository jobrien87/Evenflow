// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query — see
// agencyChat.test.js). The one real external dependency, lib/boberdoo.js,
// is monkey-patched per scenario (plain CommonJS module-object mutation,
// no experimental Node flags needed — both this file and
// recordStoreProvisioning.js resolve the same cached module instance).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const boberdoo = require('./boberdoo');
const provisioning = require('./recordStoreProvisioning');

const suffix = Date.now();
let agencyId;
let templateId;
let template2Id;
let ownerId;

const originalBoberdoo = { ...boberdoo };
function resetBoberdoo() {
  Object.assign(boberdoo, originalBoberdoo);
}

before(async () => {
  const agency = await prisma.agency.create({
    data: { name: `Record Store Test Agency ${suffix}`, address: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  });
  agencyId = agency.id;

  const owner = await prisma.user.create({
    data: { email: `rs-owner-${suffix}@test.local`, firstName: 'Ada', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId, phone: '5125551234' },
  });
  ownerId = owner.id;

  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_AUTO_BASIC_${suffix}`, displayName: 'Test Auto Basic', productCategory: 'AUTO', leadType: 'INTERNET', wholesalePriceCents: 2500, minimumDailyVolume: 1, maximumDailyVolume: 100, defaultDailyVolume: 10, minimumDepositCents: 150000 },
  });
  templateId = template.id;

  const template2 = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_HOME_BASIC_${suffix}`, displayName: 'Test Home Basic', productCategory: 'HOME', leadType: 'INTERNET', wholesalePriceCents: 3000, minimumDailyVolume: 1, maximumDailyVolume: 100, defaultDailyVolume: 10, minimumDepositCents: 150000 },
  });
  template2Id = template2.id;
});

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.recordStoreTemplate.deleteMany({ where: { id: { in: [templateId, template2Id] } } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

let partnerCounter;
let filterSetCounter;

beforeEach(async () => {
  resetBoberdoo();
  partnerCounter = 0;
  filterSetCounter = 0;
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerId: null, boberdooPartnerStatus: null, recordStoreDepositConfirmedAt: null, recordStoreBalanceCents: null } });
});
function fakeHappyBoberdoo() {
  boberdoo.isConfigured = () => true;
  boberdoo.createPartner = async () => ({ success: true, partnerId: `P-${++partnerCounter}` });
  boberdoo.setPartnerStatus = async () => ({ success: true });
  boberdoo.createFilterSet = async () => ({ success: true, filterSetId: `F-${++filterSetCounter}` });
  boberdoo.setFilterSetStatus = async () => ({ success: true });
  boberdoo.updateFilterSetDailyVolume = async () => ({ success: true });
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 150000, totalBalanceCents: 150000 });
  boberdoo.getPartnerInfo = async () => ({ success: true, data: {} });
  boberdoo.getPaymentPageUrl = () => 'https://example.com/pay';
}

async function loadTemplate(id) {
  return prisma.recordStoreTemplate.findUnique({ where: { id } });
}

test('a new agency buying a product creates a Partner + Filter Set, leaves it paused, pending funding', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 20, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, true);
  assert.equal(result.subscription.status, 'PENDING_FUNDING');
  assert.ok(result.subscription.boberdooFilterSetId);
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.ok(agency.boberdooPartnerId);
  assert.equal(agency.boberdooPartnerStatus, 0, 'partner must be left in the safe/inactive state');

  const events = await prisma.auditEvent.findMany({ where: { agencyId, action: 'BOBERDOO_PARTNER_CREATED' } });
  assert.equal(events.length, 1);
});

test('a second product under the same agency reuses the existing Partner — never creates a second one', async () => {
  fakeHappyBoberdoo();
  const t1 = await loadTemplate(templateId);
  const t2 = await loadTemplate(template2Id);

  const order1 = await provisioning.createOrder({ agencyId, template: t1, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(order1.subscription.id);
  const agencyAfterFirst = await prisma.agency.findUnique({ where: { id: agencyId } });

  const order2 = await provisioning.createOrder({ agencyId, template: t2, dailyVolume: 15, userId: ownerId });
  const result2 = await provisioning.provisionSubscription(order2.subscription.id);

  const agencyAfterSecond = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.equal(agencyAfterSecond.boberdooPartnerId, agencyAfterFirst.boberdooPartnerId);
  assert.equal(partnerCounter, 1, 'createPartner must only have been called once across both products');
  assert.notEqual(result2.subscription.boberdooFilterSetId, order1.subscription.boberdooFilterSetId);
});

test('Partner creation failure lands the subscription on ERROR with a friendly message, no partnerId stored', async () => {
  fakeHappyBoberdoo();
  boberdoo.createPartner = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'Partner_ID invalid' });
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, false);
  assert.equal(result.errorMessage, provisioning.FRIENDLY_ERROR, 'the raw provider error must never reach the customer');
  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(updated.status, 'ERROR');
  assert.equal(updated.failedStep, 'BOBERDOO_PARTNER_CREATING');
  assert.equal(updated.errorCode, 'PROVIDER_ERROR');
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.equal(agency.boberdooPartnerId, null);
});

test('Filter Set creation failure lands on ERROR but keeps the already-created Partner', async () => {
  fakeHappyBoberdoo();
  boberdoo.createFilterSet = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'bad filter config' });
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, false);
  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(updated.failedStep, 'FILTER_SET_CREATING');
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.ok(agency.boberdooPartnerId, 'the partner created before the failure must not be discarded');
});

test('retrying a failed provision never creates a duplicate Partner or Filter Set', async () => {
  fakeHappyBoberdoo();
  boberdoo.createFilterSet = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'temporary outage' });
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);
  assert.equal(partnerCounter, 1);

  // Fix the simulated outage, then retry — createPartner must be skipped
  // entirely (idempotent), and only one new Filter Set created.
  boberdoo.createFilterSet = async () => ({ success: true, filterSetId: `F-${++filterSetCounter}` });
  const retryResult = await provisioning.provisionSubscription(subscription.id);

  assert.equal(retryResult.success, true);
  assert.equal(partnerCounter, 1, 'retry must never call createPartner again');
});

test('duplicate checkout clicks for the same product return the same order, never two', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const order1 = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const order2 = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  assert.equal(order1.subscription.id, order2.subscription.id);
  assert.equal(order2.created, false);

  const count = await prisma.recordStoreSubscription.count({ where: { agencyId, recordStoreTemplateId: templateId } });
  assert.equal(count, 1);
});

test('payment incomplete: a zero balance never activates the subscription', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);

  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 0, totalBalanceCents: 0 });
  const result = await provisioning.refreshFundingStatus(subscription.id);

  assert.equal(result.satisfied, false);
  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(updated.status, 'PENDING_FUNDING');
});

test('payment completed: a real balance activates the Filter Set and the Partner', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);

  const result = await provisioning.refreshFundingStatus(subscription.id);

  assert.equal(result.satisfied, true);
  assert.equal(result.subscription.status, 'ACTIVE');
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.ok(agency.recordStoreDepositConfirmedAt);
  assert.equal(agency.boberdooPartnerStatus, 2);
});

test('pause then resume a single subscription', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);
  await provisioning.refreshFundingStatus(subscription.id);

  const paused = await provisioning.pauseSubscription(subscription.id, ownerId);
  assert.equal(paused.success, true);
  assert.equal(paused.subscription.status, 'PAUSED');
  assert.equal(paused.subscription.desiredStatus, 'PAUSED');

  const resumed = await provisioning.resumeSubscription(subscription.id, ownerId);
  assert.equal(resumed.success, true);
  assert.equal(resumed.subscription.status, 'ACTIVE');
});

test('pausing the whole account, then resuming, restores only what was really on before (master spec §19 worked example)', async () => {
  fakeHappyBoberdoo();
  const t1 = await loadTemplate(templateId);
  const t2 = await loadTemplate(template2Id);

  const order1 = await provisioning.createOrder({ agencyId, template: t1, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(order1.subscription.id);
  await provisioning.refreshFundingStatus(order1.subscription.id); // Auto Basic -> ACTIVE

  const order2 = await provisioning.createOrder({ agencyId, template: t2, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(order2.subscription.id);
  await provisioning.refreshFundingStatus(order2.subscription.id); // Home Basic -> ACTIVE
  await provisioning.pauseSubscription(order2.subscription.id, ownerId); // owner individually pauses Home Basic

  await provisioning.pauseAccount(agencyId, ownerId);
  let auto = await prisma.recordStoreSubscription.findUnique({ where: { id: order1.subscription.id } });
  let home = await prisma.recordStoreSubscription.findUnique({ where: { id: order2.subscription.id } });
  assert.equal(auto.status, 'ACCOUNT_PAUSED');
  assert.equal(home.status, 'PAUSED', 'an individually-paused product is untouched by an account-level pause');

  await provisioning.resumeAccount(agencyId, ownerId);
  auto = await prisma.recordStoreSubscription.findUnique({ where: { id: order1.subscription.id } });
  home = await prisma.recordStoreSubscription.findUnique({ where: { id: order2.subscription.id } });
  assert.equal(auto.status, 'ACTIVE', 'Auto Basic resumes');
  assert.equal(home.status, 'PAUSED', 'Home Preferred stays paused — the exact worked example from the spec');
});

test('changing daily volume updates the real record on success', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);
  boberdoo.updateFilterSetDailyVolume = async () => ({ success: true });
  const result = await provisioning.changeDailyVolume(subscription.id, 35, ownerId);
  assert.equal(result.success, true);
  assert.equal(result.subscription.dailyVolume, 35);
});

test('a Boberdoo failure during a volume change never changes the stored volume', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);
  boberdoo.updateFilterSetDailyVolume = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'rejected' });

  const result = await provisioning.changeDailyVolume(subscription.id, 35, ownerId);
  assert.equal(result.success, false);
  const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(updated.dailyVolume, 10, 'the old volume must be preserved on failure');
});

test('Boberdoo not configured at all degrades honestly — no fabricated Partner ID', async () => {
  boberdoo.isConfigured = () => false;
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, false);
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.equal(agency.boberdooPartnerId, null);
});

// ---- Genuine concurrency (Promise.all, not sequential awaits) ----------
// The tests above prove idempotency across SEQUENTIAL repeat calls, which
// a simple "does it already exist" check always passes trivially. These
// prove the real double-click/race case: two requests landing at the
// database at the same moment, which a plain check-then-write is NOT safe
// against without either a DB constraint or (as createOrder now does) a
// SERIALIZABLE transaction, and which provisionSubscription's atomic
// claim must be the SOLE gate for (not a secondary status-based check a
// concurrent winner's own write could falsify).

test('two genuinely simultaneous checkout clicks for the same product create exactly one subscription', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);

  const [a, b] = await Promise.all([
    provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId }),
    provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId }),
  ]);

  assert.equal(a.subscription.id, b.subscription.id, 'both calls must resolve to the same one real row');
  assert.equal([a.created, b.created].filter(Boolean).length, 1, 'exactly one of the two calls actually created it');

  const count = await prisma.recordStoreSubscription.count({ where: { agencyId, recordStoreTemplateId: templateId } });
  assert.equal(count, 1, 'no duplicate row was left behind by the race');
});

test('two genuinely simultaneous Provision clicks on the same order create exactly one real Partner and Filter Set', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });

  const [a, b] = await Promise.all([
    provisioning.provisionSubscription(subscription.id),
    provisioning.provisionSubscription(subscription.id),
  ]);

  assert.ok(a.success || b.success, 'at least one of the two concurrent calls must succeed');
  assert.equal(partnerCounter, 1, 'a real race must never create two Boberdoo Partners for one order');
  assert.equal(filterSetCounter, 1, 'a real race must never create two Boberdoo Filter Sets for one order');

  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.ok(agency.boberdooPartnerId, 'the agency must end up with exactly the one real Partner id');
});

test('billing/delivery never crosses agencies — two different agencies buying the same product get distinct Partners and Filter Sets', async () => {
  fakeHappyBoberdoo();
  const otherAgency = await prisma.agency.create({
    data: { name: `Record Store Cross-Agency Test ${suffix}`, address: '456 Side St', city: 'Dallas', state: 'TX', zip: '75201' },
  });
  const otherOwner = await prisma.user.create({
    data: { email: `rs-owner-other-${suffix}@test.local`, firstName: 'Bea', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: otherAgency.id, phone: '2145550000' },
  });
  const template = await loadTemplate(templateId);

  const orderA = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(orderA.subscription.id);
  const orderB = await provisioning.createOrder({ agencyId: otherAgency.id, template, dailyVolume: 10, userId: otherOwner.id });
  await provisioning.provisionSubscription(orderB.subscription.id);

  const [agencyA, agencyB, subA, subB] = await Promise.all([
    prisma.agency.findUnique({ where: { id: agencyId } }),
    prisma.agency.findUnique({ where: { id: otherAgency.id } }),
    prisma.recordStoreSubscription.findUnique({ where: { id: orderA.subscription.id } }),
    prisma.recordStoreSubscription.findUnique({ where: { id: orderB.subscription.id } }),
  ]);

  assert.notEqual(agencyA.boberdooPartnerId, agencyB.boberdooPartnerId, 'each agency must get its own real Boberdoo Partner — never shared');
  assert.notEqual(subA.boberdooFilterSetId, subB.boberdooFilterSetId, 'each agency\'s order must get its own Filter Set — never shared, so leads can never cross-deliver to the wrong agency');
  assert.equal(subA.boberdooPartnerId, agencyA.boberdooPartnerId);
  assert.equal(subB.boberdooPartnerId, agencyB.boberdooPartnerId);

  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId: otherAgency.id } });
  await prisma.auditEvent.deleteMany({ where: { agencyId: otherAgency.id } });
  await prisma.user.delete({ where: { id: otherOwner.id } });
  await prisma.agency.delete({ where: { id: otherAgency.id } });
});
