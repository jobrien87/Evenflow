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
  await prisma.recordStoreFundingPayment.deleteMany({ where: { agencyId } });
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

test('Boberdoo Login is a synthetic, agency-scoped value — never the owner\'s real email', async () => {
  // Confirmed live against the real account (2026-10-23): a second
  // createNewPartner call reusing an already-taken Login is rejected
  // outright ("Login name X is taken by another Client!"). Since
  // owner.email never changes, using it as Login meant any agency whose
  // Partner got created in Boberdoo but never persisted locally (a crash/
  // timeout between the two) would be permanently stuck re-failing every
  // retry. Login must be something guaranteed unique per agency instead.
  fakeHappyBoberdoo();
  let capturedLogin;
  boberdoo.createPartner = async (args) => {
    capturedLogin = args.login;
    return { success: true, partnerId: `P-${++partnerCounter}` };
  };
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, true);
  assert.ok(capturedLogin, 'createPartner must have been called with a login');
  assert.notEqual(capturedLogin, `rs-owner-${suffix}@test.local`, 'Login must never be the owner\'s real email');
  assert.ok(capturedLogin.includes(agencyId), 'Login should be scoped to this exact agency so a retry can never collide with an unrelated earlier attempt');
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

test('owner with no phone on file is blocked before Boberdoo is ever called — actionable MISSING_PHONE', async () => {
  fakeHappyBoberdoo();
  await prisma.user.update({ where: { id: ownerId }, data: { phone: null } });
  try {
    const template = await loadTemplate(templateId);
    const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
    const result = await provisioning.provisionSubscription(subscription.id);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'MISSING_PHONE');
    assert.equal(result.errorMessage, provisioning.FRIENDLY_ERROR, 'the customer-facing message must still be the standard friendly copy');
    assert.equal(partnerCounter, 0, 'Boberdoo must never be called when the owner has no phone on file');
    const updated = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
    assert.equal(updated.status, 'ERROR');
    assert.equal(updated.errorCode, 'MISSING_PHONE');
    assert.equal(updated.failedStep, 'BOBERDOO_PARTNER_CREATING');
    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    assert.equal(agency.boberdooPartnerId, null);
  } finally {
    await prisma.user.update({ where: { id: ownerId }, data: { phone: '5125551234' } });
  }
});

test('owner with a phone on file proceeds past the check normally — no regression', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  const result = await provisioning.provisionSubscription(subscription.id);

  assert.equal(result.success, true);
  assert.equal(partnerCounter, 1);
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

// ---- Funding payment submission (real Stripe charge -> Boberdoo credit) --

test('submitFundingPayment credits the real Boberdoo Partner balance and marks the payment SUBMITTED', async () => {
  fakeHappyBoberdoo();
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 10, userId: ownerId });
  await provisioning.provisionSubscription(subscription.id);

  boberdoo.submitPayment = async () => ({ success: true, totalBalanceCents: 250000 });
  // refreshFundingStatus (invoked by submitFundingPayment below, since this
  // payment is tied to a subscription) re-reads the balance independently —
  // keep the two mocks consistent with what a real post-credit read would
  // return, matching the real Boberdoo account actually being at 250000.
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 250000, totalBalanceCents: 250000 });

  const payment = await prisma.recordStoreFundingPayment.create({
    data: { agencyId, recordStoreSubscriptionId: subscription.id, amountCents: 150000, stripeCheckoutSessionId: `cs_test_${Date.now()}` },
  });

  const result = await provisioning.submitFundingPayment(payment.id, 'test-correlation');
  assert.equal(result.success, true);
  assert.equal(result.payment.status, 'SUBMITTED');
  assert.ok(result.payment.submittedAt);
  assert.equal(result.payment.boberdooTotalBalanceCents, 250000);

  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.equal(agency.recordStoreBalanceCents, 250000);

  // Tied to a PENDING_FUNDING subscription — crediting a real balance must
  // activate it, reusing refreshFundingStatus's own existing logic.
  const updatedSub = await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(updatedSub.status, 'ACTIVE');

  await prisma.recordStoreFundingPayment.delete({ where: { id: payment.id } });
});

test('submitFundingPayment marks the payment FAILED (never loses it) when Boberdoo rejects the call', async () => {
  fakeHappyBoberdoo();
  boberdoo.submitPayment = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'nope' });

  const payment = await prisma.recordStoreFundingPayment.create({
    data: { agencyId, amountCents: 50000, stripeCheckoutSessionId: `cs_test_${Date.now()}` },
  });

  const result = await provisioning.submitFundingPayment(payment.id, 'test-correlation');
  assert.equal(result.success, false);

  const updated = await prisma.recordStoreFundingPayment.findUnique({ where: { id: payment.id } });
  assert.equal(updated.status, 'FAILED');
  assert.ok(updated.failedReason);

  await prisma.recordStoreFundingPayment.delete({ where: { id: payment.id } });
});

test('submitFundingPayment is a safe no-op when called again on an already-SUBMITTED payment', async () => {
  fakeHappyBoberdoo();
  let callCount = 0;
  boberdoo.submitPayment = async () => { callCount += 1; return { success: true, totalBalanceCents: 100000 }; };
  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerId: `P-${++partnerCounter}` } });

  const payment = await prisma.recordStoreFundingPayment.create({
    data: { agencyId, amountCents: 100000, stripeCheckoutSessionId: `cs_test_${Date.now()}` },
  });

  await provisioning.submitFundingPayment(payment.id, 'test-correlation');
  const second = await provisioning.submitFundingPayment(payment.id, 'test-correlation');

  assert.equal(second.alreadySubmitted, true);
  assert.equal(callCount, 1, 'a second call must never submit a real payment to Boberdoo twice');

  await prisma.recordStoreFundingPayment.delete({ where: { id: payment.id } });
});

test('submitPendingFundingPayments processes every PENDING_SUBMIT/FAILED row, regardless of how it got there', async () => {
  fakeHappyBoberdoo();
  boberdoo.submitPayment = async () => ({ success: true, totalBalanceCents: 99900 });
  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerId: `P-${++partnerCounter}` } });

  const [pending, failed, alreadyDone] = await Promise.all([
    prisma.recordStoreFundingPayment.create({ data: { agencyId, amountCents: 10000, stripeCheckoutSessionId: `cs_test_${Date.now()}_a` } }),
    prisma.recordStoreFundingPayment.create({ data: { agencyId, amountCents: 20000, stripeCheckoutSessionId: `cs_test_${Date.now()}_b`, status: 'FAILED', failedReason: 'previous attempt failed' } }),
    prisma.recordStoreFundingPayment.create({ data: { agencyId, amountCents: 30000, stripeCheckoutSessionId: `cs_test_${Date.now()}_c`, status: 'SUBMITTED', submittedAt: new Date() } }),
  ]);

  await provisioning.submitPendingFundingPayments('test-correlation');

  const [a, b, c] = await Promise.all([
    prisma.recordStoreFundingPayment.findUnique({ where: { id: pending.id } }),
    prisma.recordStoreFundingPayment.findUnique({ where: { id: failed.id } }),
    prisma.recordStoreFundingPayment.findUnique({ where: { id: alreadyDone.id } }),
  ]);
  assert.equal(a.status, 'SUBMITTED');
  assert.equal(b.status, 'SUBMITTED', 'a previously-FAILED row must be retried, not skipped forever');
  assert.equal(c.status, 'SUBMITTED', 'an already-submitted row is left alone');

  await prisma.recordStoreFundingPayment.deleteMany({ where: { id: { in: [pending.id, failed.id, alreadyDone.id] } } });
});

// ---- Custom Builder -------------------------------------------------

test('customConfigurationJson overrides template.configurationJson at filter-set creation time, never touching a fixed template', async () => {
  fakeHappyBoberdoo();
  let sentFields;
  boberdoo.createFilterSet = async (partnerId, fields) => { sentFields = fields; return { success: true, filterSetId: `F-${++filterSetCounter}` }; };

  await prisma.recordStoreTemplate.update({ where: { id: templateId }, data: { configurationJson: { TYPE: 23, Filter_Set_Price: 5 } } });
  const template = await loadTemplate(templateId);
  const { subscription } = await provisioning.createOrder({ agencyId, template, dailyVolume: 20, userId: ownerId });
  await prisma.recordStoreSubscription.update({ where: { id: subscription.id }, data: { customConfigurationJson: { Filter_Set_Price: 9, Accepted_Sources: 'Fidadto' } } });

  await provisioning.provisionSubscription(subscription.id);

  assert.equal(sentFields.TYPE, 23, 'fields the override does not touch still come from the template');
  assert.equal(sentFields.Filter_Set_Price, 9, 'the override wins over the template default');
  assert.equal(sentFields.Accepted_Sources, 'Fidadto');

  await prisma.recordStoreTemplate.update({ where: { id: templateId }, data: { configurationJson: null } });
});

test('createSubscriptionFromQuote creates a priced, provisionable subscription from an accepted custom request and marks it CONVERTED', async () => {
  const customTemplate = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_CUSTOM_BUILDER_${suffix}`, displayName: 'Build Your Own', productCategory: 'CUSTOM', leadType: 'INTERNET', isCustomBuilder: true },
  });
  const request = await prisma.recordStoreCustomRequest.create({
    data: {
      agencyId, requestedById: ownerId, leadTypeLabel: 'Auto Insurance', boberdooTypeId: '23',
      sources: ['Fidadto', 'Quoting_Fast'], dailyLimit: 12, status: 'QUOTED', quotedPriceCents: 700,
    },
  });

  const { subscription } = await provisioning.createSubscriptionFromQuote(request, customTemplate, ownerId);

  assert.equal(subscription.priceSnapshotCents, 700);
  assert.equal(subscription.dailyVolume, 12);
  assert.equal(subscription.recordStoreTemplateId, customTemplate.id);
  assert.equal(subscription.customConfigurationJson.TYPE, 23);
  assert.equal(subscription.customConfigurationJson.Filter_Set_Price, 7);
  assert.equal(subscription.customConfigurationJson.Accepted_Sources, 'Fidadto,Quoting_Fast');
  assert.equal(subscription.customConfigurationJson.Daily_Limit, 12);

  const updatedRequest = await prisma.recordStoreCustomRequest.findUnique({ where: { id: request.id } });
  assert.equal(updatedRequest.status, 'CONVERTED');
  assert.equal(updatedRequest.recordStoreSubscriptionId, subscription.id);

  fakeHappyBoberdoo();
  let sentFields;
  boberdoo.createFilterSet = async (partnerId, fields) => { sentFields = fields; return { success: true, filterSetId: `F-${++filterSetCounter}` }; };
  const result = await provisioning.provisionSubscription(subscription.id);
  assert.equal(result.success, true);
  assert.equal(result.subscription.status, 'PENDING_FUNDING');
  assert.equal(sentFields.TYPE, 23, 'the real request-derived config is what actually reaches Boberdoo');

  await prisma.recordStoreSubscription.deleteMany({ where: { id: subscription.id } });
  await prisma.recordStoreCustomRequest.delete({ where: { id: request.id } });
  await prisma.recordStoreTemplate.delete({ where: { id: customTemplate.id } });
});

// ---- Low-balance gate -------------------------------------------------

test('checkBalanceForAdditionalProduct always allows an agency\'s first-ever product, even with a failing/low balance check', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: false, errorCode: 'PROVIDER_ERROR' });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  assert.equal(agency.recordStoreDepositConfirmedAt, null, 'precondition: never funded before');
  const result = await provisioning.checkBalanceForAdditionalProduct(agency);
  assert.equal(result.ok, true, 'a real Boberdoo call must never even be consulted for a first-ever product');
});

test('checkBalanceForAdditionalProduct blocks an already-funded agency below the default $250 threshold', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 10000, totalBalanceCents: 10000 });
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date() } });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  const result = await provisioning.checkBalanceForAdditionalProduct(agency);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'LOW_BALANCE');
  assert.equal(result.currentBalanceCents, 10000);
  assert.equal(result.requiredBalanceCents, 50000);
});

test('checkBalanceForAdditionalProduct allows an already-funded agency at or above the threshold', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 25000, totalBalanceCents: 25000 });
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date() } });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  const result = await provisioning.checkBalanceForAdditionalProduct(agency);
  assert.equal(result.ok, true, 'exactly at the threshold must pass (>=, not >)');
});

test('checkBalanceForAdditionalProduct respects admin-configured thresholds over the defaults', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 40000, totalBalanceCents: 40000 });
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date() } });
  await prisma.recordStorePlatformSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', lowBalanceThresholdCents: 50000, topUpTargetCents: 100000 },
    update: { lowBalanceThresholdCents: 50000, topUpTargetCents: 100000 },
  });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  const result = await provisioning.checkBalanceForAdditionalProduct(agency);
  // $400 would clear the $250 default but not a $500 configured threshold.
  assert.equal(result.ok, false);
  assert.equal(result.requiredBalanceCents, 100000);
  await prisma.recordStorePlatformSettings.delete({ where: { id: 'singleton' } });
});

test('checkBalanceForAdditionalProduct surfaces an honest error if the real balance can\'t be read, never silently allows or blocks', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: false, errorCode: 'NETWORK_ERROR' });
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date() } });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  const result = await provisioning.checkBalanceForAdditionalProduct(agency);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BALANCE_CHECK_FAILED');
});

test('listSources returns the real list when Boberdoo succeeds, and an honest fallback (live: false) when it fails', async () => {
  boberdoo.getVendorsAndSources = async () => ({
    success: true,
    vendors: [{ name: 'Vendor A', sources: [{ name: 'SourceOne' }, { name: 'SourceTwo' }] }, { name: 'Vendor B', sources: [{ name: 'SourceOne' }] }],
  });
  const live = await provisioning.listSources('23');
  assert.equal(live.live, true);
  assert.deepEqual([...live.sources.map((s) => s.value)].sort(), ['SourceOne', 'SourceTwo']);
  // Every source is returned as { value, label } — the raw code is never
  // the only thing a caller gets back; label is always the EvenFlow-
  // branded display name (see lib/recordStoreSourceLabels.js).
  assert.ok(live.sources.every((s) => typeof s.label === 'string' && s.label.startsWith('EvenFlow ')));

  boberdoo.getVendorsAndSources = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'Authentication failed' });
  const fallback = await provisioning.listSources('23');
  assert.equal(fallback.live, false);
  assert.ok(fallback.sources.length > 0, 'a real, non-empty fallback list is still returned so the builder stays usable');
  assert.ok(fallback.sources.every((s) => s.value && s.label));
});

// ---- importExistingFilterSet (real Partner, pre-existing Boberdoo filter set) ----

test('importExistingFilterSet refuses an agency with no linked Partner yet', async () => {
  const unlinkedAgency = await prisma.agency.create({ data: { name: `Unlinked Import Test Agency ${suffix}` } });
  try {
    const result = await provisioning.importExistingFilterSet(unlinkedAgency.id, 'FS-WHATEVER', ownerId);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NOT_LINKED');
  } finally {
    await prisma.agency.delete({ where: { id: unlinkedAgency.id } });
  }
});

test('importExistingFilterSet pulls the real price/caps/sources from Boberdoo (never hand-typed) and creates an ACTIVE subscription', async () => {
  const linkedAgency = await prisma.agency.create({ data: { name: `Linked Import Test Agency ${suffix}`, boberdooPartnerId: `P-import-${suffix}` } });
  try {
    boberdoo.getFilterSet = async (filterSetId) => ({
      success: true,
      data: {
        Filter_Set_ID: filterSetId,
        Filter_Set_Name: 'Tom\'s Existing Auto Filter',
        Filter_Set_Price: 8.5,
        Daily_Limit: 15,
        TYPE: 23,
        Accepted_Sources: 'Fidadto,Quoting_Fast',
      },
    });

    const result = await provisioning.importExistingFilterSet(linkedAgency.id, `FS-import-${suffix}`, ownerId);
    assert.equal(result.success, true);
    const { subscription } = result;
    assert.equal(subscription.agencyId, linkedAgency.id);
    assert.equal(subscription.boberdooFilterSetId, `FS-import-${suffix}`);
    assert.equal(subscription.boberdooPartnerId, `P-import-${suffix}`);
    assert.equal(subscription.priceSnapshotCents, 850, 'price comes from the real Boberdoo response, in cents, never hand-typed');
    assert.equal(subscription.dailyVolume, 15);
    assert.equal(subscription.status, 'ACTIVE');
    assert.equal(subscription.provisioningStatus, 'ACTIVE');
    assert.equal(subscription.fundingStatus, 'CONFIRMED');
    assert.equal(subscription.customConfigurationJson.Accepted_Sources, 'Fidadto,Quoting_Fast');

    const template = await prisma.recordStoreTemplate.findUnique({ where: { id: subscription.recordStoreTemplateId } });
    assert.equal(template.isCustomBuilder, true, 'an imported filter set is always filed under the custom-builder template, never a guessed fixed SKU');

    await prisma.recordStoreSubscription.delete({ where: { id: subscription.id } });
  } finally {
    await prisma.agency.delete({ where: { id: linkedAgency.id } });
  }
});

test('importExistingFilterSet refuses to import the same filter set twice', async () => {
  const agency = await prisma.agency.create({ data: { name: `Dup Import Test Agency ${suffix}`, boberdooPartnerId: `P-dup-${suffix}` } });
  try {
    boberdoo.getFilterSet = async (filterSetId) => ({ success: true, data: { Filter_Set_ID: filterSetId, Filter_Set_Price: 5, Daily_Limit: 10, TYPE: 21 } });
    const first = await provisioning.importExistingFilterSet(agency.id, `FS-dup-${suffix}`, ownerId);
    assert.equal(first.success, true);

    const second = await provisioning.importExistingFilterSet(agency.id, `FS-dup-${suffix}`, ownerId);
    assert.equal(second.success, false);
    assert.equal(second.errorCode, 'ALREADY_IMPORTED');

    await prisma.recordStoreSubscription.delete({ where: { id: first.subscription.id } });
  } finally {
    await prisma.agency.delete({ where: { id: agency.id } });
  }
});

test('importExistingFilterSet surfaces an honest error when Boberdoo cannot find that filter set', async () => {
  const agency = await prisma.agency.create({ data: { name: `Bad Import Test Agency ${suffix}`, boberdooPartnerId: `P-bad-${suffix}` } });
  try {
    boberdoo.getFilterSet = async () => ({ success: false, errorCode: 'PROVIDER_ERROR', errorMessage: 'Filter set not found' });
    const result = await provisioning.importExistingFilterSet(agency.id, `FS-bad-${suffix}`, ownerId);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'PROVIDER_ERROR');
  } finally {
    await prisma.agency.delete({ where: { id: agency.id } });
  }
});
