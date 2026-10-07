// Record Store's provisioning orchestrator — the one place that coordinates
// EvenFlow's own RecordStoreSubscription state with real Boberdoo Partner/
// Filter Set calls (lib/boberdoo.js). Treated as a transaction/state
// machine per the master spec: every step is idempotent (checks what
// already exists before creating anything), every outcome is recorded via
// recordAudit, and a failure never leaves a subscription in an ambiguous
// state — it lands on ERROR with a real failedStep/errorCode/errorMessage
// a Super Admin can retry from.
//
// SOURCE OF TRUTH: EvenFlow is authoritative for product selection, desired
// daily volume, and desired on/off state (RecordStoreSubscription.
// desiredStatus). Boberdoo is authoritative for Partner existence, the real
// Filter Set, actual balance, and lead delivery. When a Boberdoo call fails,
// this module never silently overwrites local state to match a guess —
// it records the disagreement (boberdooSyncError) and leaves the customer-
// facing status exactly where it was before the attempt.
const { prisma } = require('./db');
const boberdoo = require('./boberdoo');
const { recordAudit } = require('./audit');
const { notifyAgencyOwners } = require('./notifications');

// Never leak a raw provider error to an Agency Owner (see master spec §29) —
// this is what every customer-facing error message resolves to, while the
// real errorCode/errorMessage still lands in the subscription row and the
// audit trail for Super Admin's eyes only.
const FRIENDLY_ERROR = "We couldn't update your lead program. Your current settings have not been changed. Our team has been notified.";

function isIprTemplate(template) {
  return !!template.isIpr || template.filterSetType === 'IPR';
}

// ---- Order creation ----------------------------------------------------

// Idempotent against the "buy the same product twice" double-click case —
// an agency only ever has one non-cancelled subscription per template.
// The check-then-create below is run inside a SERIALIZABLE transaction
// specifically because a plain read-then-write is a real race under
// genuine concurrency (two simultaneous checkout clicks can both pass the
// "nothing exists yet" check before either row is written) — there is no
// DB-level unique constraint to fall back on here, since a CANCELLED/ERROR
// row must be allowed to coexist with a fresh new order for the same
// product. SERIALIZABLE makes Postgres itself detect the conflict and
// abort one of the two transactions with a serialization failure, which
// is retried here rather than surfaced as an error — the caller always
// gets back the one real row, never a duplicate.
async function createOrder({ agencyId, template, dailyVolume, userId, ringToPhone, maxConcurrentCalls }) {
  const volume = Math.max(template.minimumDailyVolume, Math.min(template.maximumDailyVolume, Math.round(dailyVolume)));

  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.recordStoreSubscription.findFirst({
          where: {
            agencyId,
            recordStoreTemplateId: template.id,
            status: { notIn: ['CANCELLED', 'ERROR'] },
          },
        });
        if (existing) {
          return { subscription: existing, created: false };
        }

        const subscription = await tx.recordStoreSubscription.create({
          data: {
            agencyId,
            recordStoreTemplateId: template.id,
            productNameSnapshot: template.displayName,
            leadType: template.leadType,
            filterSetType: template.filterSetType,
            isIpr: template.isIpr,
            priceSnapshotCents: template.wholesalePriceCents || 0,
            dailyVolume: volume,
            ringToPhone: template.isIpr ? ringToPhone || null : null,
            maxConcurrentCalls: template.isIpr ? maxConcurrentCalls || null : null,
            status: 'DRAFT',
            provisioningStatus: 'EVENFLOW_ORDER_CREATED',
            createdById: userId,
          },
        });
        return { subscription, created: true };
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (err) {
      // P2034 = Prisma's code for a Postgres serialization failure under
      // SERIALIZABLE isolation — exactly the "lost the race" case this is
      // designed to catch. Retrying re-runs the check, which now sees the
      // winning transaction's row and correctly returns created: false.
      if (err.code === 'P2034' && attempt < 4) continue;
      throw err;
    }
  }

  if (result.created) {
    await recordAudit({
      actorId: userId,
      agencyId,
      action: 'RECORD_STORE_ORDER_CREATED',
      entityType: 'RecordStoreSubscription',
      entityId: result.subscription.id,
      after: { templateSlug: template.slug, dailyVolume: volume },
    });
  }

  return result;
}

// ---- Step 1: Partner (one per Agency, never one per product) ----------

async function provisionPartner(agency, owner, correlationId) {
  if (agency.boberdooPartnerId) {
    return { success: true, partnerId: agency.boberdooPartnerId, alreadyExisted: true };
  }
  if (!boberdoo.isConfigured()) {
    return { success: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Boberdoo is not configured.' };
  }

  const result = await boberdoo.createPartner({
    login: owner.email,
    companyName: agency.name,
    firstName: owner.firstName,
    lastName: owner.lastName,
    address: agency.address,
    city: agency.city,
    state: agency.state,
    zip: agency.zip,
    phone: owner.phone,
    leadEmail: owner.email,
  });
  if (!result.success || !result.partnerId) {
    return { success: false, errorCode: result.errorCode || 'PARTNER_CREATE_FAILED', errorMessage: result.errorMessage || 'Partner creation did not return an ID.' };
  }

  // Defensively force the safe/inactive state right after creation —
  // never assume Boberdoo's own create-time default (see master spec §10).
  await boberdoo.setPartnerStatus(result.partnerId, 0, 'Record Store — awaiting initial deposit');

  await prisma.agency.update({
    where: { id: agency.id },
    data: { boberdooPartnerId: result.partnerId, boberdooPartnerStatus: 0, boberdooSyncStatus: 'SYNCED', boberdooLastSyncAt: new Date() },
  });

  await recordAudit({
    agencyId: agency.id,
    action: 'BOBERDOO_PARTNER_CREATED',
    entityType: 'Agency',
    entityId: agency.id,
    after: { boberdooPartnerId: result.partnerId },
    correlationId,
  });

  return { success: true, partnerId: result.partnerId, alreadyExisted: false };
}

// ---- Step 2: Filter Set (one per subscription) -------------------------

async function provisionFilterSet(subscription, template, partnerId, correlationId) {
  if (subscription.boberdooFilterSetId) {
    return { success: true, filterSetId: subscription.boberdooFilterSetId, alreadyExisted: true };
  }
  if (!boberdoo.isConfigured()) {
    return { success: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Boberdoo is not configured.' };
  }

  const config = template.configurationJson || {};
  let result;
  if (isIprTemplate(template)) {
    result = await boberdoo.createIprFilterSet(partnerId, {
      ...config,
      Daily_Limit: subscription.dailyVolume,
      ...(subscription.ringToPhone ? { Partner_Ring_To: subscription.ringToPhone } : {}),
      ...(subscription.maxConcurrentCalls ? { Max_Concurrent_Calls: subscription.maxConcurrentCalls } : {}),
    });
  } else {
    result = await boberdoo.createFilterSet(partnerId, { ...config });
  }
  if (!result.success || !result.filterSetId) {
    return { success: false, errorCode: result.errorCode || 'FILTER_SET_CREATE_FAILED', errorMessage: result.errorMessage || 'Filter set creation did not return an ID.' };
  }

  // Standard filter sets have a documented explicit pause call
  // (setFilterSetStatus); IPR has no documented status toggle, so a
  // freshly-created IPR filter set is left exactly as created (Daily_Limit
  // was already set above, not yet activated via any other real field) —
  // see pauseSubscription's own comment for how IPR pause/resume works.
  if (!isIprTemplate(template)) {
    await boberdoo.setFilterSetStatus(partnerId, result.filterSetId, 0);
  }

  await prisma.recordStoreSubscription.update({
    where: { id: subscription.id },
    data: { boberdooPartnerId: partnerId, boberdooFilterSetId: result.filterSetId },
  });

  await recordAudit({
    agencyId: subscription.agencyId,
    action: 'FILTER_SET_CREATED',
    entityType: 'RecordStoreSubscription',
    entityId: subscription.id,
    after: { boberdooFilterSetId: result.filterSetId },
    correlationId,
  });

  return { success: true, filterSetId: result.filterSetId, alreadyExisted: false };
}

async function markError(subscriptionId, { failedStep, errorCode, errorMessage }) {
  return prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'ERROR',
      provisioningStatus: 'PROVISIONING_ERROR',
      failedStep,
      errorCode,
      errorMessage,
      retryCount: { increment: 1 },
    },
  });
}

// ---- Full provisioning run (also what RETRY re-invokes) ----------------
// Idempotent end to end: every sub-step checks what already exists before
// creating anything, so calling this twice on the same subscription never
// creates a second Partner or Filter Set.
async function provisionSubscription(subscriptionId, correlationId) {
  // Atomic claim — guards the common "double-click Provision" case (master
  // spec §30/§21): only one in-flight run proceeds past this point.
  const claim = await prisma.recordStoreSubscription.updateMany({
    where: { id: subscriptionId, status: { in: ['DRAFT', 'ERROR'] } },
    data: { status: 'PENDING_PROVISIONING', provisioningStatus: 'BOBERDOO_PARTNER_CREATING' },
  });

  const subscription = await prisma.recordStoreSubscription.findUnique({
    where: { id: subscriptionId },
    include: { template: true, agency: { include: { users: { where: { role: 'AGENCY_OWNER' }, take: 1 } } } },
  });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Subscription not found.' };
  if (claim.count === 0) {
    // This call did not win the atomic claim above — either a concurrent
    // call is mid-flight right now (status just flipped to
    // PENDING_PROVISIONING a moment ago), or this subscription is already
    // past this stage entirely. Either way, THIS call must never go on to
    // perform the real Boberdoo side effects below — doing so previously
    // only required the current status to differ from a hardcoded list,
    // which a concurrent winner's own in-flight write could make true,
    // letting two calls create two real Partners for one order. Simply
    // report current state instead; a real retry re-wins the claim on its
    // own next call once status has genuinely settled on ERROR.
    return { success: subscription.status !== 'ERROR', subscription };
  }

  const owner = subscription.agency.users[0];
  if (!owner) {
    await markError(subscriptionId, { failedStep: 'BOBERDOO_PARTNER_CREATING', errorCode: 'NO_OWNER', errorMessage: 'Agency has no Agency Owner to provision under.' });
    return { success: false, errorCode: 'NO_OWNER', errorMessage: FRIENDLY_ERROR };
  }

  const partnerResult = await provisionPartner(subscription.agency, owner, correlationId);
  if (!partnerResult.success) {
    await markError(subscriptionId, { failedStep: 'BOBERDOO_PARTNER_CREATING', errorCode: partnerResult.errorCode, errorMessage: partnerResult.errorMessage });
    return { success: false, errorCode: partnerResult.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { provisioningStatus: 'BOBERDOO_PARTNER_CREATED' } });

  const filterResult = await provisionFilterSet(subscription, subscription.template, partnerResult.partnerId, correlationId);
  if (!filterResult.success) {
    await markError(subscriptionId, { failedStep: 'FILTER_SET_CREATING', errorCode: filterResult.errorCode, errorMessage: filterResult.errorMessage });
    return { success: false, errorCode: filterResult.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  // If this agency already satisfied its deposit on an earlier product,
  // there's no second deposit to wait on — the shared Partner is already
  // funded. Otherwise the subscription waits for funding confirmation.
  const alreadyFunded = !!subscription.agency.recordStoreDepositConfirmedAt;
  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: alreadyFunded ? 'PENDING_PROVISIONING' : 'PENDING_FUNDING',
      provisioningStatus: alreadyFunded ? 'DEPOSIT_CONFIRMED' : 'WAITING_FOR_DEPOSIT',
      fundingStatus: alreadyFunded ? 'CONFIRMED' : 'PENDING',
    },
    include: { template: true, agency: true },
  });

  if (alreadyFunded) {
    return activateSubscription(subscriptionId, correlationId);
  }

  return { success: true, subscription: updated, paymentPageUrl: boberdoo.getPaymentPageUrl() };
}

// ---- Funding confirmation ------------------------------------------------

async function isInitialDepositSatisfied(agency) {
  if (!agency.boberdooPartnerId) return { satisfied: false, errorCode: 'NO_PARTNER' };
  const balanceResult = await boberdoo.getPartnerBalance(agency.boberdooPartnerId);
  if (!balanceResult.success) return { satisfied: false, errorCode: balanceResult.errorCode, errorMessage: balanceResult.errorMessage };
  const satisfied = (balanceResult.balanceCents || 0) > 0 || (balanceResult.totalBalanceCents || 0) > 0;
  return { satisfied, balanceCents: balanceResult.balanceCents, totalBalanceCents: balanceResult.totalBalanceCents };
}

// Called when the customer returns from the payment page, clicks "I've
// completed payment", or an admin/scheduled sync refreshes it — NEVER
// because of the redirect alone (master spec §14).
async function refreshFundingStatus(subscriptionId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({
    where: { id: subscriptionId },
    include: { template: true, agency: true },
  });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };

  const depositCheck = await isInitialDepositSatisfied(subscription.agency);
  if (depositCheck.errorCode && depositCheck.errorCode !== 'NO_PARTNER') {
    await prisma.agency.update({ where: { id: subscription.agency.id }, data: { boberdooSyncStatus: 'ERROR', boberdooSyncError: depositCheck.errorMessage, boberdooLastSyncAt: new Date() } });
    return { success: false, errorCode: depositCheck.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  await prisma.agency.update({
    where: { id: subscription.agency.id },
    data: {
      recordStoreBalanceCents: depositCheck.totalBalanceCents ?? depositCheck.balanceCents ?? null,
      recordStoreBalanceCheckedAt: new Date(),
      boberdooSyncStatus: 'SYNCED',
      boberdooSyncError: null,
      boberdooLastSyncAt: new Date(),
      ...(depositCheck.satisfied && !subscription.agency.recordStoreDepositConfirmedAt ? { recordStoreDepositConfirmedAt: new Date() } : {}),
    },
  });

  if (!depositCheck.satisfied) {
    return { success: true, satisfied: false, subscription };
  }

  await recordAudit({ agencyId: subscription.agency.id, action: 'DEPOSIT_CONFIRMED', entityType: 'Agency', entityId: subscription.agency.id, correlationId });

  if (subscription.status === 'PENDING_FUNDING') {
    await prisma.recordStoreSubscription.update({
      where: { id: subscriptionId },
      data: { status: 'PENDING_PROVISIONING', provisioningStatus: 'DEPOSIT_CONFIRMED', fundingStatus: 'CONFIRMED' },
    });
    const activation = await activateSubscription(subscriptionId, correlationId);
    return { ...activation, satisfied: true };
  }

  return { success: true, satisfied: true, subscription };
}

// ---- Activation -----------------------------------------------------

async function activateSubscription(subscriptionId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({
    where: { id: subscriptionId },
    include: { template: true, agency: true },
  });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };
  if (subscription.status === 'ACTIVE') return { success: true, subscription, alreadyActive: true };

  if (!subscription.boberdooFilterSetId || !subscription.agency.boberdooPartnerId) {
    return { success: false, errorCode: 'NOT_PROVISIONED', errorMessage: FRIENDLY_ERROR };
  }
  if (!subscription.agency.recordStoreDepositConfirmedAt) {
    return { success: false, errorCode: 'NOT_FUNDED', errorMessage: 'This agency has not yet confirmed its initial deposit.' };
  }

  await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { provisioningStatus: 'ACTIVATING' } });

  const activateResult = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprDailyVolume(subscription.boberdooFilterSetId, subscription.dailyVolume)
    : await boberdoo.setFilterSetStatus(subscription.agency.boberdooPartnerId, subscription.boberdooFilterSetId, 1);

  if (!activateResult.success) {
    await markError(subscriptionId, { failedStep: 'ACTIVATING', errorCode: activateResult.errorCode, errorMessage: activateResult.errorMessage });
    return { success: false, errorCode: activateResult.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  // Only flip the shared Partner Active the first time THIS agency has any
  // active product — a second product under the same funded Partner never
  // needs this repeated.
  if (subscription.agency.boberdooPartnerStatus !== 2) {
    const partnerActivate = await boberdoo.setPartnerStatus(subscription.agency.boberdooPartnerId, 2, 'Record Store — deposit confirmed');
    if (!partnerActivate.success) {
      await markError(subscriptionId, { failedStep: 'ACTIVATING', errorCode: partnerActivate.errorCode, errorMessage: partnerActivate.errorMessage });
      return { success: false, errorCode: partnerActivate.errorCode, errorMessage: FRIENDLY_ERROR };
    }
    await prisma.agency.update({ where: { id: subscription.agency.id }, data: { boberdooPartnerStatus: 2 } });
    await recordAudit({ agencyId: subscription.agency.id, action: 'PARTNER_RESUMED', entityType: 'Agency', entityId: subscription.agency.id, metadata: { reason: 'first_active_product' }, correlationId });
  }

  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: { status: 'ACTIVE', provisioningStatus: 'ACTIVE', desiredStatus: 'ACTIVE', startedAt: new Date(), errorCode: null, errorMessage: null, failedStep: null },
  });

  await recordAudit({ agencyId: subscription.agencyId, action: 'FILTER_SET_ACTIVATED', entityType: 'RecordStoreSubscription', entityId: subscriptionId, correlationId });
  await notifyAgencyOwners(subscription.agencyId, {
    type: 'record_store.activated',
    severity: 'ACTION',
    title: `${subscription.productNameSnapshot} is now live`,
    body: `Your ${subscription.productNameSnapshot} lead program is active at ${subscription.dailyVolume}/day.`,
  });

  return { success: true, subscription: updated };
}

// ---- Pause / resume (single product) ------------------------------------

async function pauseSubscription(subscriptionId, actorId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId }, include: { template: true, agency: true } });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };
  if (subscription.status !== 'ACTIVE') return { success: false, errorCode: 'NOT_ACTIVE', errorMessage: 'This program is not currently active.' };

  // IPR filter sets have no documented Status toggle (see
  // docs/lead-portal-api-reference.md §3) — Daily_Limit is the one real,
  // documented field that controls flow, so pause sets it to 0 rather than
  // inventing an unsupported status field.
  const result = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprDailyVolume(subscription.boberdooFilterSetId, 0)
    : await boberdoo.setFilterSetStatus(subscription.agency.boberdooPartnerId, subscription.boberdooFilterSetId, 0);

  if (!result.success) {
    await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { boberdooSyncError: result.errorMessage, lastBoberdooSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: { status: 'PAUSED', desiredStatus: 'PAUSED', pausedAt: new Date(), boberdooSyncError: null, lastBoberdooSyncAt: new Date() },
  });
  await recordAudit({ actorId, agencyId: subscription.agencyId, action: 'FILTER_SET_PAUSED', entityType: 'RecordStoreSubscription', entityId: subscriptionId, correlationId });
  return { success: true, subscription: updated };
}

async function resumeSubscription(subscriptionId, actorId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId }, include: { template: true, agency: true } });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };
  if (subscription.status !== 'PAUSED') return { success: false, errorCode: 'NOT_PAUSED', errorMessage: 'This program is not currently paused.' };
  if (subscription.agency.boberdooPartnerStatus === 1) {
    return { success: false, errorCode: 'ACCOUNT_PAUSED', errorMessage: 'Your whole Record Store account is paused — resume the account first.' };
  }

  const result = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprDailyVolume(subscription.boberdooFilterSetId, subscription.dailyVolume)
    : await boberdoo.setFilterSetStatus(subscription.agency.boberdooPartnerId, subscription.boberdooFilterSetId, 1);

  if (!result.success) {
    await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { boberdooSyncError: result.errorMessage, lastBoberdooSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: { status: 'ACTIVE', desiredStatus: 'ACTIVE', pausedAt: null, boberdooSyncError: null, lastBoberdooSyncAt: new Date() },
  });
  await recordAudit({ actorId, agencyId: subscription.agencyId, action: 'FILTER_SET_RESUMED', entityType: 'RecordStoreSubscription', entityId: subscriptionId, correlationId });
  return { success: true, subscription: updated };
}

// ---- Pause / resume (whole account) --------------------------------------

async function pauseAccount(agencyId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency || !agency.boberdooPartnerId) return { success: false, errorCode: 'NO_PARTNER', errorMessage: 'No Record Store account to pause yet.' };

  const result = await boberdoo.setPartnerStatus(agency.boberdooPartnerId, 1, 'Record Store — account paused by owner');
  if (!result.success) {
    await prisma.agency.update({ where: { id: agencyId }, data: { boberdooSyncStatus: 'ERROR', boberdooSyncError: result.errorMessage, boberdooLastSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerStatus: 1, boberdooSyncStatus: 'SYNCED', boberdooSyncError: null, boberdooLastSyncAt: new Date() } });
  // Only subscriptions the owner WANTS active move to ACCOUNT_PAUSED —
  // one already individually paused (desiredStatus PAUSED) is untouched,
  // so resuming the account later restores exactly what was really on.
  await prisma.recordStoreSubscription.updateMany({
    where: { agencyId, status: 'ACTIVE', desiredStatus: 'ACTIVE' },
    data: { status: 'ACCOUNT_PAUSED' },
  });
  await recordAudit({ actorId, agencyId, action: 'PARTNER_PAUSED', entityType: 'Agency', entityId: agencyId, correlationId });
  return { success: true };
}

async function resumeAccount(agencyId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency || !agency.boberdooPartnerId) return { success: false, errorCode: 'NO_PARTNER', errorMessage: 'No Record Store account to resume yet.' };

  const result = await boberdoo.setPartnerStatus(agency.boberdooPartnerId, 2, 'Record Store — account resumed by owner');
  if (!result.success) {
    await prisma.agency.update({ where: { id: agencyId }, data: { boberdooSyncStatus: 'ERROR', boberdooSyncError: result.errorMessage, boberdooLastSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }
  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerStatus: 2, boberdooSyncStatus: 'SYNCED', boberdooSyncError: null, boberdooLastSyncAt: new Date() } });

  // Restore ONLY what was account-paused — never a subscription the owner
  // had individually paused beforehand (master spec §19's worked example).
  const toResume = await prisma.recordStoreSubscription.findMany({ where: { agencyId, status: 'ACCOUNT_PAUSED' }, include: { template: true } });
  for (const sub of toResume) {
    const resumeResult = isIprTemplate(sub.template)
      ? await boberdoo.updateIprDailyVolume(sub.boberdooFilterSetId, sub.dailyVolume)
      : await boberdoo.setFilterSetStatus(agency.boberdooPartnerId, sub.boberdooFilterSetId, 1);
    if (resumeResult.success) {
      await prisma.recordStoreSubscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', boberdooSyncError: null, lastBoberdooSyncAt: new Date() } });
    } else {
      // A per-filter-set failure here doesn't block the rest — surfaced via
      // boberdooSyncError on that one row for admin/owner visibility.
      await prisma.recordStoreSubscription.update({ where: { id: sub.id }, data: { boberdooSyncError: resumeResult.errorMessage, lastBoberdooSyncAt: new Date() } });
    }
  }

  await recordAudit({ actorId, agencyId, action: 'PARTNER_RESUMED', entityType: 'Agency', entityId: agencyId, correlationId });
  return { success: true };
}

// ---- Daily volume change ------------------------------------------------

async function changeDailyVolume(subscriptionId, newVolume, actorId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId }, include: { template: true, agency: true } });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };

  const clamped = Math.max(subscription.template.minimumDailyVolume, Math.min(subscription.template.maximumDailyVolume, Math.round(newVolume)));
  if (!subscription.boberdooFilterSetId) return { success: false, errorCode: 'NOT_PROVISIONED', errorMessage: FRIENDLY_ERROR };

  const config = subscription.template.configurationJson || {};
  const result = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprDailyVolume(subscription.boberdooFilterSetId, clamped)
    : await boberdoo.updateFilterSetDailyVolume(subscription.boberdooFilterSetId, clamped, { volumeField: config.volumeField });

  if (!result.success) {
    await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { boberdooSyncError: result.errorMessage, lastBoberdooSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: result.errorCode === 'VOLUME_FIELD_NOT_CONFIGURED' ? 'This product is not yet fully configured for volume changes. Our team has been notified.' : FRIENDLY_ERROR };
  }

  const before = subscription.dailyVolume;
  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: { dailyVolume: clamped, boberdooSyncError: null, lastBoberdooSyncAt: new Date() },
  });
  await recordAudit({ actorId, agencyId: subscription.agencyId, action: 'DAILY_VOLUME_CHANGED', entityType: 'RecordStoreSubscription', entityId: subscriptionId, before: { dailyVolume: before }, after: { dailyVolume: clamped }, correlationId });
  return { success: true, subscription: updated };
}

// ---- Admin: link an existing Boberdoo account ---------------------------

async function linkExistingPartner(agencyId, partnerId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { success: false, errorCode: 'NOT_FOUND' };
  if (agency.boberdooPartnerId && agency.boberdooPartnerId !== partnerId) {
    return { success: false, errorCode: 'ALREADY_LINKED', errorMessage: 'This agency is already linked to a different Boberdoo Partner.' };
  }

  const info = await boberdoo.getPartnerInfo(partnerId);
  if (!info.success) return { success: false, errorCode: info.errorCode, errorMessage: info.errorMessage || 'Could not verify that Partner ID.' };

  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerId: partnerId, boberdooSyncStatus: 'SYNCED', boberdooLastSyncAt: new Date() } });
  await recordAudit({ actorId, agencyId, action: 'BOBERDOO_PARTNER_LINKED', entityType: 'Agency', entityId: agencyId, after: { boberdooPartnerId: partnerId }, correlationId });
  return { success: true, partnerInfo: info.data };
}

// ---- Balance refresh (the "REFRESH BALANCE" button) ----------------------

async function refreshAgencyBalance(agencyId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { success: false, errorCode: 'NOT_FOUND' };
  if (!agency.boberdooPartnerId) {
    return { success: true, balanceCents: null, lastUpdatedAt: null, noPartnerYet: true };
  }

  const result = await boberdoo.getPartnerBalance(agency.boberdooPartnerId);
  if (!result.success) {
    await prisma.agency.update({ where: { id: agencyId }, data: { boberdooSyncStatus: 'ERROR', boberdooSyncError: result.errorMessage, boberdooLastSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  const balanceCents = result.totalBalanceCents ?? result.balanceCents ?? null;
  const updated = await prisma.agency.update({
    where: { id: agencyId },
    data: { recordStoreBalanceCents: balanceCents, recordStoreBalanceCheckedAt: new Date(), boberdooSyncStatus: 'SYNCED', boberdooSyncError: null, boberdooLastSyncAt: new Date() },
  });
  return { success: true, balanceCents: updated.recordStoreBalanceCents, lastUpdatedAt: updated.recordStoreBalanceCheckedAt };
}

module.exports = {
  FRIENDLY_ERROR,
  refreshAgencyBalance,
  createOrder,
  provisionSubscription,
  refreshFundingStatus,
  isInitialDepositSatisfied,
  activateSubscription,
  pauseSubscription,
  resumeSubscription,
  pauseAccount,
  resumeAccount,
  changeDailyVolume,
  linkExistingPartner,
};
