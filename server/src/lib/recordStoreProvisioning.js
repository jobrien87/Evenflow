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
const crypto = require('crypto');
const { prisma } = require('./db');
const boberdoo = require('./boberdoo');
const { recordAudit } = require('./audit');
const { notifyAgencyOwners } = require('./notifications');
const { labelSources } = require('./recordStoreSourceLabels');

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
// Confirmed-real source names (used by all 4 existing fixed templates'
// Accepted_Sources) — the only fallback when getVendorsAndSources itself
// fails. Confirmed 2026-10-22: this account's API key can set
// Accepted_Sources on a filter set but doesn't have permission to call
// getVendorsAndSources (or getPartnerList) to list valid values — a real
// scope limit on the key, not a bug. Never presented as live data; every
// caller also gets back `live: false` alongside this list.
const FALLBACK_SOURCES = ['Fidadto', 'Quoting_Fast', 'Visiqua'];

// ---- Custom Builder: list available lead sources for a lead type -------
// Returns { value, label } pairs, never a raw code alone — value is what
// a caller sends back (and what Accepted_Sources needs), label is the
// only thing ever shown to a user (see lib/recordStoreSourceLabels.js).
async function listSources(boberdooTypeId) {
  const result = await boberdoo.getVendorsAndSources(boberdooTypeId);
  const codes = result.success
    ? [...new Set((result.vendors || []).flatMap((v) => (v.sources || []).map((s) => s.name)))]
    : FALLBACK_SOURCES;
  const sources = await labelSources(codes);
  return { success: true, sources, live: result.success };
}

// ---- Low-balance gate for an additional product --------------------
// An agency's very FIRST-EVER Record Store product always goes through
// the existing minimum-deposit flow unchanged (agency.
// recordStoreDepositConfirmedAt is null, so this returns ok immediately).
// Once an agency has funded at least once, adding a product for a lead
// type they don't currently hold is gated on their real, current
// Boberdoo balance rather than requiring a fresh deposit every time —
// but only while that balance stays healthy. Thresholds are a Platform-
// Owner-editable singleton (RecordStorePlatformSettings), never
// hardcoded, since these are real business numbers that can change.
async function checkBalanceForAdditionalProduct(agency) {
  if (!agency.recordStoreDepositConfirmedAt) return { ok: true };

  const settings = await prisma.recordStorePlatformSettings.findUnique({ where: { id: 'singleton' } });
  const lowBalanceThresholdCents = settings?.lowBalanceThresholdCents ?? 25000;
  const topUpTargetCents = settings?.topUpTargetCents ?? 50000;

  const balanceResult = await boberdoo.getPartnerBalance(agency.boberdooPartnerId);
  if (!balanceResult.success) {
    return { ok: false, errorCode: 'BALANCE_CHECK_FAILED', errorMessage: 'Could not verify your current balance. Please try again shortly.' };
  }
  const currentBalanceCents = balanceResult.totalBalanceCents ?? balanceResult.balanceCents ?? 0;
  if (currentBalanceCents >= lowBalanceThresholdCents) return { ok: true };

  return {
    ok: false,
    errorCode: 'LOW_BALANCE',
    errorMessage: `Your balance is below $${(lowBalanceThresholdCents / 100).toFixed(2)}. Add funds to bring it above $${(topUpTargetCents / 100).toFixed(2)} before adding another lead type.`,
    currentBalanceCents,
    requiredBalanceCents: topUpTargetCents,
  };
}

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

// ---- Custom Builder: convert an accepted quote into a real subscription --
// Deliberately NOT a call to createOrder() above — its dedup check is
// scoped by recordStoreTemplateId, and every custom subscription shares
// the one CUSTOM_BUILDER template row, so reusing it would wrongly block
// an agency from ever having two custom programs (e.g. one Auto, one
// Home) at once. Uniqueness here is enforced by the request's own
// recordStoreSubscriptionId (@unique) instead — one accepted quote, one
// subscription, ever.
async function createSubscriptionFromQuote(request, template, userId) {
  const dailyVolume = request.dailyLimit && request.dailyLimit > 0 ? request.dailyLimit : template.defaultDailyVolume;
  // The Boberdoo-side Filter_Set_Price is derived directly from the
  // quote — no separate markup is modeled yet (nothing in this request
  // collects one), so the price a Platform Owner quotes the agency is
  // exactly the per-lead price sent to Boberdoo. A real markup layer can
  // be added later without touching anything downstream of this.
  const filterSetPrice = Math.round(request.quotedPriceCents) / 100;

  const subscription = await prisma.recordStoreSubscription.create({
    data: {
      agencyId: request.agencyId,
      recordStoreTemplateId: template.id,
      productNameSnapshot: `${template.displayName} — ${request.leadTypeLabel}`,
      leadType: template.leadType,
      filterSetType: template.filterSetType,
      isIpr: template.isIpr,
      priceSnapshotCents: request.quotedPriceCents,
      dailyVolume,
      status: 'DRAFT',
      provisioningStatus: 'EVENFLOW_ORDER_CREATED',
      createdById: userId,
      customConfigurationJson: {
        TYPE: Number(request.boberdooTypeId),
        Filter_Set_Name: `${request.leadTypeLabel} (Custom)`,
        Filter_Set_Price: filterSetPrice,
        Accepted_Sources: (request.sources || []).join(','),
        Match_Priority: 0,
        Daily_Limit: dailyVolume,
        Weekly_Limit: request.weeklyLimit && request.weeklyLimit > 0 ? request.weeklyLimit : 0,
        Monthly_Limit: request.monthlyLimit && request.monthlyLimit > 0 ? request.monthlyLimit : 0,
        Accept_Only_Reprocessed_Leads: 'No',
      },
    },
  });

  await prisma.recordStoreCustomRequest.update({
    where: { id: request.id },
    data: { status: 'CONVERTED', recordStoreSubscriptionId: subscription.id },
  });

  await recordAudit({
    actorId: userId,
    agencyId: request.agencyId,
    action: 'RECORD_STORE_CUSTOM_REQUEST_CONVERTED',
    entityType: 'RecordStoreSubscription',
    entityId: subscription.id,
    after: { recordStoreCustomRequestId: request.id, priceCents: request.quotedPriceCents },
  });

  return { subscription };
}

// ---- Step 1: Partner (one per Agency, never one per product) ----------

async function provisionPartner(agency, owner, correlationId) {
  if (agency.boberdooPartnerId) {
    return { success: true, partnerId: agency.boberdooPartnerId, alreadyExisted: true };
  }
  if (!boberdoo.isConfigured()) {
    return { success: false, errorCode: 'NOT_CONFIGURED', errorMessage: "Record Store's lead exchange is not configured." };
  }

  // Boberdoo requires a Password on createNewPartner (confirmed against a
  // real account 2026-10-22 — not in the docs' own field list). Nothing in
  // EvenFlow ever logs into Boberdoo's portal as this Partner — every real
  // interaction goes through the API key — so this is generated fresh and
  // immediately discarded, never stored or logged.
  //
  // Login is a synthetic, agency-scoped value, deliberately never the
  // owner's real email. Confirmed live against the real account
  // (2026-10-23): a second createNewPartner with a Login already in use
  // fails outright ("Login name X is taken by another Client!"), and an
  // owner's email can easily collide with an earlier attempt for this
  // exact agency that created a real Partner in Boberdoo but never
  // managed to persist agency.boberdooPartnerId locally (a crash/timeout
  // between the two) — every retry after that point would hit this same
  // wall forever, since owner.email never changes. Lead_Email below still
  // carries the real owner email — that field is what actually matters
  // functionally (where Boberdoo would send lead notifications); Login is
  // purely an internal bookkeeping key nothing in EvenFlow ever reads
  // back, so it can safely be something guaranteed unique instead.
  const result = await boberdoo.createPartner({
    login: `agency-${agency.id}@record-store.yield-marketing.com`,
    password: crypto.randomBytes(18).toString('base64'),
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

// Every field insertUpdateFilterSet treats as required on create (see
// docs/lead-portal-api-reference.md's "Filter sets" table) that is NOT
// guaranteed by this module's own code — Daily_Limit is excluded here
// since it's always set explicitly from subscription.dailyVolume below,
// never left to the template config alone.
const REQUIRED_STANDARD_FILTER_SET_FIELDS = ['TYPE', 'Filter_Set_Price', 'Accepted_Sources', 'Match_Priority', 'Weekly_Limit', 'Monthly_Limit', 'Accept_Only_Reprocessed_Leads'];

async function provisionFilterSet(subscription, template, partnerId, correlationId) {
  if (subscription.boberdooFilterSetId) {
    return { success: true, filterSetId: subscription.boberdooFilterSetId, alreadyExisted: true };
  }
  if (!boberdoo.isConfigured()) {
    return { success: false, errorCode: 'NOT_CONFIGURED', errorMessage: "Record Store's lead exchange is not configured." };
  }

  // customConfigurationJson overrides the template's own config — null on
  // every subscription bought from one of the fixed templates (so their
  // behavior is unchanged), populated only on a subscription created from
  // an accepted RecordStoreCustomRequest quote (see createSubscriptionFromQuote).
  const config = { ...(template.configurationJson || {}), ...(subscription.customConfigurationJson || {}) };
  let result;
  if (isIprTemplate(template)) {
    result = await boberdoo.createIprFilterSet(partnerId, {
      ...config,
      Daily_Limit: subscription.dailyVolume,
      ...(subscription.ringToPhone ? { Partner_Ring_To: subscription.ringToPhone } : {}),
      ...(subscription.maxConcurrentCalls ? { Max_Concurrent_Calls: subscription.maxConcurrentCalls } : {}),
    });
  } else {
    // Catch an incomplete template config here, before ever calling
    // Boberdoo — configurationJson is Super-Admin-entered once into a raw
    // JSON textarea with no shape validation (see routes/recordStore.js's
    // admin template PATCH schema, z.record(z.any())), and callAction
    // silently drops any field that's simply absent rather than erroring.
    // A missing TYPE, for instance, surfaces only as Boberdoo's own
    // opaque "Lead type invalid" — this gives the Platform Owner the
    // exact field name instead, in the same errorCode/errorMessage the
    // Admin Panel's debug view already shows (never shown to a customer,
    // who still only ever sees FRIENDLY_ERROR).
    const missingFields = REQUIRED_STANDARD_FILTER_SET_FIELDS.filter((field) => config[field] === undefined || config[field] === null);
    if (missingFields.length > 0) {
      return {
        success: false,
        errorCode: 'TEMPLATE_MISCONFIGURED',
        errorMessage: `Template is missing required configuration field(s): ${missingFields.join(', ')}`,
      };
    }

    // Daily_Limit must come from the customer's own chosen dailyVolume,
    // never silently fall back to whatever a Super Admin last typed into
    // the template's own configurationJson — this module's own header
    // comment states EvenFlow, not the template, is authoritative for
    // desired daily volume. The IPR branch above already gets this right;
    // this mirrors it. Safe for the Custom Builder path too, since
    // createSubscriptionFromQuote already keeps customConfigurationJson's
    // own Daily_Limit in sync with subscription.dailyVolume — this is
    // never a conflicting value there, just an explicit restatement.
    result = await boberdoo.createFilterSet(partnerId, { ...config, Daily_Limit: subscription.dailyVolume });
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
  // Boberdoo's createNewPartner requires Phone, and callAction silently
  // drops a null param rather than sending it empty — so a missing owner
  // phone was previously only ever caught by Boberdoo itself, landing as
  // an opaque PROVIDER_ERROR no customer could act on. Caught here first,
  // before ever calling Boberdoo, with a named errorCode the UI can show
  // an actionable "add your phone" message for instead (see
  // RecordStoreWizard.jsx/RecordStorePanel.jsx) — this is the one
  // provisioning failure a customer can actually fix themselves, unlike
  // every other real provider error.
  if (!owner.phone) {
    await markError(subscriptionId, { failedStep: 'BOBERDOO_PARTNER_CREATING', errorCode: 'MISSING_PHONE', errorMessage: 'Agency owner has no phone number on file.' });
    return { success: false, errorCode: 'MISSING_PHONE', errorMessage: FRIENDLY_ERROR };
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

  return { success: true, subscription: updated };
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

// ---- Admin: full teardown + reset to never-purchased state (reusable) ----
// Boberdoo's integrated API has no delete-Partner or delete-FilterSet call
// — a real reset on the Boberdoo side can only ever mean driving every
// filter set, then the Partner itself, to inactive (Status 0). The same
// Partner ID is deliberately kept (never nulled) so a REUSED test account
// doesn't accumulate a fresh orphaned Partner in the real Boberdoo account
// on every repeat reset — provisionPartner() above already reuses
// agency.boberdooPartnerId whenever it's set, so the next real purchase
// re-activates the SAME Partner instead of creating a new one. (A fresh
// Filter Set IS created per new subscription on the next purchase, same
// as any normal order — the old, now-permanently-inactive one from before
// this reset stays in Boberdoo's own records forever, invisible anywhere
// in EvenFlow and incapable of ever delivering a lead or billing again;
// an accepted, unavoidable byproduct of Boberdoo having no real delete.)
//
// Boberdoo calls are attempted BEFORE the local wipe and are strictly
// best-effort: a failure on one subscription's filter set (e.g. one
// Boberdoo already considers gone) is collected and returned, never
// allowed to block clearing local state — which always succeeds as long
// as the database itself is healthy.
//
// Real financial/CRM data a reset must NEVER delete: RecordStoreFundingPayment
// rows (actual Stripe charges — detached, not deleted) and Lead rows already
// delivered through this agency's subscriptions (detached, not deleted).
async function resetAgencyRecordStore(agencyId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Agency not found.' };

  const subscriptions = await prisma.recordStoreSubscription.findMany({
    where: { agencyId },
    include: { template: true },
  });

  // ---- Real Boberdoo side first, best-effort ---------------------------
  const boberdooWarnings = [];
  for (const sub of subscriptions) {
    if (!sub.boberdooFilterSetId) continue; // never provisioned — nothing to turn off
    // eslint-disable-next-line no-await-in-loop
    const result = isIprTemplate(sub.template)
      ? await boberdoo.updateIprDailyVolume(sub.boberdooFilterSetId, 0)
      : await boberdoo.setFilterSetStatus(agency.boberdooPartnerId, sub.boberdooFilterSetId, 0);
    if (!result.success) {
      boberdooWarnings.push({ subscriptionId: sub.id, productNameSnapshot: sub.productNameSnapshot, errorCode: result.errorCode, errorMessage: result.errorMessage });
    }
  }

  let partnerDeactivateWarning = null;
  if (agency.boberdooPartnerId) {
    const partnerResult = await boberdoo.setPartnerStatus(agency.boberdooPartnerId, 0, 'Record Store — reset to never-purchased state');
    if (!partnerResult.success) {
      partnerDeactivateWarning = { errorCode: partnerResult.errorCode, errorMessage: partnerResult.errorMessage };
    }
  }

  // ---- Local wipe — always runs, regardless of the Boberdoo outcomes ---
  const subscriptionIds = subscriptions.map((s) => s.id);
  const wipedCounts = await prisma.$transaction(async (tx) => {
    const leadsDetached = (await tx.lead.updateMany({
      where: { recordStoreSubscriptionId: { in: subscriptionIds } },
      data: { recordStoreSubscriptionId: null, recordStoreSourceCode: null },
    })).count;

    // Required FK — must go before the parent Subscription delete below.
    const sourceOptimizations = (await tx.recordStoreSourceOptimization.deleteMany({
      where: { recordStoreSubscriptionId: { in: subscriptionIds } },
    })).count;

    // Real Stripe-charge rows — detached, never deleted.
    const fundingPaymentsDetached = (await tx.recordStoreFundingPayment.updateMany({
      where: { recordStoreSubscriptionId: { in: subscriptionIds } },
      data: { recordStoreSubscriptionId: null },
    })).count;

    // Quote-negotiation rows — deleted entirely; no quote history needs to
    // survive a "looks brand new" reset. Must go before Subscription
    // delete below (recordStoreSubscriptionId is a real FK on this model).
    const customRequests = (await tx.recordStoreCustomRequest.deleteMany({ where: { agencyId } })).count;

    const subscriptionsDeleted = (await tx.recordStoreSubscription.deleteMany({ where: { agencyId } })).count;

    await tx.agency.update({
      where: { id: agencyId },
      data: {
        boberdooPartnerStatus: 0,
        boberdooSyncStatus: 'SYNCED',
        boberdooSyncError: null,
        boberdooLastSyncAt: new Date(),
        recordStoreDepositConfirmedAt: null,
        recordStoreBalanceCents: null,
        recordStoreBalanceCheckedAt: null,
        // boberdooPartnerId deliberately left untouched — see header comment.
      },
    });

    return { subscriptions: subscriptionsDeleted, customRequests, sourceOptimizations, leadsDetached, fundingPaymentsDetached };
  }, { timeout: 30000 });

  await recordAudit({
    actorId,
    agencyId,
    action: 'RECORD_STORE_AGENCY_RESET',
    entityType: 'Agency',
    entityId: agencyId,
    after: { wipedCounts, boberdooWarnings, partnerDeactivateWarning },
    correlationId,
  });

  return { success: true, wipedCounts, boberdooWarnings, partnerDeactivateWarning };
}

// ---- Daily volume change ------------------------------------------------

async function changeDailyVolume(subscriptionId, newVolume, actorId, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId }, include: { template: true, agency: true } });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };

  const clamped = Math.max(subscription.template.minimumDailyVolume, Math.min(subscription.template.maximumDailyVolume, Math.round(newVolume)));
  if (!subscription.boberdooFilterSetId) return { success: false, errorCode: 'NOT_PROVISIONED', errorMessage: FRIENDLY_ERROR };

  const result = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprDailyVolume(subscription.boberdooFilterSetId, clamped)
    : await boberdoo.updateFilterSetDailyVolume(subscription.boberdooFilterSetId, subscription.agency.boberdooPartnerId, clamped);

  if (!result.success) {
    await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { boberdooSyncError: result.errorMessage, lastBoberdooSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  const before = subscription.dailyVolume;
  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: { dailyVolume: clamped, boberdooSyncError: null, lastBoberdooSyncAt: new Date() },
  });
  await recordAudit({ actorId, agencyId: subscription.agencyId, action: 'DAILY_VOLUME_CHANGED', entityType: 'RecordStoreSubscription', entityId: subscriptionId, before: { dailyVolume: before }, after: { dailyVolume: clamped }, correlationId });
  return { success: true, subscription: updated };
}

// ---- Source-list update (used by the 30-day auto-optimization sweep) --
// Same shape as changeDailyVolume above: push the real change to the
// lead exchange first, only ever persist the new Accepted_Sources
// locally once that call actually succeeds, and on failure record the
// disagreement (boberdooSyncError) rather than silently assuming the
// change took.
async function updateAcceptedSources(subscriptionId, newSourceCodes, correlationId) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: subscriptionId }, include: { template: true, agency: true } });
  if (!subscription) return { success: false, errorCode: 'NOT_FOUND' };
  if (!subscription.boberdooFilterSetId) return { success: false, errorCode: 'NOT_PROVISIONED', errorMessage: FRIENDLY_ERROR };

  const acceptedSources = newSourceCodes.join(',');
  const result = isIprTemplate(subscription.template)
    ? await boberdoo.updateIprFilterSet(subscription.boberdooFilterSetId, { Accepted_Sources: acceptedSources })
    : await boberdoo.updateFilterSet(subscription.boberdooFilterSetId, subscription.agency.boberdooPartnerId, { Accepted_Sources: acceptedSources });

  if (!result.success) {
    await prisma.recordStoreSubscription.update({ where: { id: subscriptionId }, data: { boberdooSyncError: result.errorMessage, lastBoberdooSyncAt: new Date() } });
    return { success: false, errorCode: result.errorCode, errorMessage: result.errorMessage };
  }

  const updated = await prisma.recordStoreSubscription.update({
    where: { id: subscriptionId },
    data: {
      customConfigurationJson: { ...(subscription.customConfigurationJson || {}), Accepted_Sources: acceptedSources },
      boberdooSyncError: null,
      lastBoberdooSyncAt: new Date(),
    },
  });
  await recordAudit({
    agencyId: subscription.agencyId, action: 'RECORD_STORE_SOURCES_OPTIMIZED', entityType: 'RecordStoreSubscription',
    entityId: subscriptionId, after: { Accepted_Sources: acceptedSources }, correlationId,
  });
  return { success: true, subscription: updated };
}

// ---- Admin: link an existing Boberdoo account ---------------------------

async function linkExistingPartner(agencyId, partnerId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { success: false, errorCode: 'NOT_FOUND' };
  if (agency.boberdooPartnerId && agency.boberdooPartnerId !== partnerId) {
    return { success: false, errorCode: 'ALREADY_LINKED', errorMessage: 'This agency is already linked to a different Record Store Partner.' };
  }

  const info = await boberdoo.getPartnerInfo(partnerId);
  if (!info.success) return { success: false, errorCode: info.errorCode, errorMessage: info.errorMessage || 'Could not verify that Partner ID.' };

  await prisma.agency.update({ where: { id: agencyId }, data: { boberdooPartnerId: partnerId, boberdooSyncStatus: 'SYNCED', boberdooLastSyncAt: new Date() } });
  await recordAudit({ actorId, agencyId, action: 'BOBERDOO_PARTNER_LINKED', entityType: 'Agency', entityId: agencyId, after: { boberdooPartnerId: partnerId }, correlationId });
  return { success: true, partnerInfo: info.data };
}

// Boberdoo Lead_Type IDs confirmed against the real account this
// integration targets -> the RecordStoreTemplate.productCategory an
// imported filter set is filed under for reporting. Mirrors
// routes/boberdooDelivery.js's own LEAD_TYPE_TO_PRODUCT map (kept
// separate rather than shared — one maps to a display product string for
// a created Lead, this one to a template's productCategory enum-like
// string; conflating them would couple two independent call sites for no
// real benefit).
const LEAD_TYPE_TO_PRODUCT_CATEGORY = { 23: 'AUTO', 21: 'HOME', 19: 'LIFE' };

// ---- Admin: import an already-live Boberdoo Filter Set --------------------
// For a real-world Partner who was already receiving leads through
// Boberdoo before being linked into EvenFlow (see linkExistingPartner
// above) — mirrors their one existing, real Filter Set into EvenFlow's own
// RecordStoreSubscription model, so it shows up in "My Lead Programs" and
// is covered by source-performance tracking/the 30-day optimizer exactly
// like one bought through EvenFlow's own storefront. Every number
// (price, daily cap, sources) is read directly from Boberdoo's own
// getFilterSet response — never hand-typed — because this is a live,
// real, already-billing business record, not a fresh order this module
// gets to define the terms of. Always filed under the CUSTOM_BUILDER
// template (never guesses which fixed-catalog SKU it "most resembles") —
// its own customConfigurationJson snapshot is what actually governs it.
async function importExistingFilterSet(agencyId, boberdooFilterSetId, actorId, correlationId) {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Agency not found.' };
  if (!agency.boberdooPartnerId) {
    return { success: false, errorCode: 'NOT_LINKED', errorMessage: 'Link this agency to its real Record Store Partner first.' };
  }

  const alreadyImported = await prisma.recordStoreSubscription.findFirst({ where: { boberdooFilterSetId } });
  if (alreadyImported) {
    return { success: false, errorCode: 'ALREADY_IMPORTED', errorMessage: 'This filter set has already been imported.' };
  }

  const result = await boberdoo.getFilterSet(boberdooFilterSetId);
  if (!result.success) {
    return { success: false, errorCode: result.errorCode || 'FILTER_SET_NOT_FOUND', errorMessage: result.errorMessage || 'Could not read that filter set from the lead exchange.' };
  }

  const data = result.data || {};
  const priceCents = Math.round(Number(data.Filter_Set_Price ?? data.filter_set_price ?? 0) * 100);
  const dailyVolume = Math.max(1, Number(data.Daily_Limit ?? data.daily_limit ?? 1) || 1);
  const leadTypeId = Number(data.TYPE ?? data.Lead_Type ?? data.lead_type);
  const filterSetName = data.Filter_Set_Name ?? data.filter_set_name ?? `Imported Filter Set ${boberdooFilterSetId}`;
  const productCategory = LEAD_TYPE_TO_PRODUCT_CATEGORY[leadTypeId] || null;

  const customBuilderTemplate = await prisma.recordStoreTemplate.findFirst({ where: { isCustomBuilder: true } });
  if (!customBuilderTemplate) return { success: false, errorCode: 'NO_CUSTOM_TEMPLATE', errorMessage: 'No custom-builder template exists to file this under.' };

  const subscription = await prisma.recordStoreSubscription.create({
    data: {
      agencyId,
      recordStoreTemplateId: customBuilderTemplate.id,
      productNameSnapshot: productCategory ? `${filterSetName} (${productCategory})` : filterSetName,
      leadType: customBuilderTemplate.leadType,
      filterSetType: 'STANDARD',
      priceSnapshotCents: priceCents,
      dailyVolume,
      status: 'ACTIVE',
      provisioningStatus: 'ACTIVE',
      fundingStatus: 'CONFIRMED',
      boberdooPartnerId: agency.boberdooPartnerId,
      boberdooFilterSetId,
      // The full real response, verbatim — this is what provisionFilterSet's
      // merge logic (template config + this) and the 30-day optimizer's
      // Accepted_Sources read/write both operate on going forward.
      customConfigurationJson: data,
      startedAt: new Date(),
      createdById: actorId,
    },
  });

  await recordAudit({
    actorId, agencyId, action: 'RECORD_STORE_FILTER_SET_IMPORTED', entityType: 'RecordStoreSubscription',
    entityId: subscription.id, after: { boberdooFilterSetId, priceCents, dailyVolume }, correlationId,
  });

  return { success: true, subscription };
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

// ---- Funding payment submission (real Stripe charge -> Boberdoo credit) --

// Credits one already-Stripe-confirmed RecordStoreFundingPayment to its
// agency's real Boberdoo Partner balance. Called right after the Stripe
// webhook's transaction commits (routes/billing.js), and safe to call
// again later (an admin retry, a periodic sync) for any row still
// PENDING_SUBMIT/FAILED — the Stripe charge itself was already captured
// durably by the webhook before this ever runs, so a failure here never
// loses the payment, it only delays Boberdoo seeing the credit.
async function submitFundingPayment(paymentId, correlationId) {
  const payment = await prisma.recordStoreFundingPayment.findUnique({ where: { id: paymentId }, include: { agency: true } });
  if (!payment) return { success: false, errorCode: 'NOT_FOUND' };
  if (payment.status === 'SUBMITTED') return { success: true, alreadySubmitted: true, payment };

  if (!payment.agency.boberdooPartnerId) {
    await prisma.recordStoreFundingPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedReason: 'Agency has no Record Store Partner yet.' } });
    return { success: false, errorCode: 'NO_PARTNER' };
  }

  const result = await boberdoo.submitPayment(payment.agency.boberdooPartnerId, payment.amountCents, payment.boberdooOperationType);
  if (!result.success) {
    await prisma.recordStoreFundingPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedReason: result.errorMessage || result.errorCode } });
    await notifyAgencyOwners(payment.agencyId, {
      type: 'record_store.funding_submit_failed',
      severity: 'WARNING',
      title: 'Record Store deposit needs attention',
      body: 'Your payment went through, but we could not yet credit it to your lead balance. Our team has been notified.',
    });
    return { success: false, errorCode: result.errorCode, errorMessage: FRIENDLY_ERROR };
  }

  const updated = await prisma.recordStoreFundingPayment.update({
    where: { id: payment.id },
    data: { status: 'SUBMITTED', submittedAt: new Date(), boberdooTotalBalanceCents: result.totalBalanceCents },
  });
  await prisma.agency.update({
    where: { id: payment.agencyId },
    data: { recordStoreBalanceCents: result.totalBalanceCents, recordStoreBalanceCheckedAt: new Date() },
  });
  await recordAudit({
    agencyId: payment.agencyId, action: 'record_store.funding_submitted', entityType: 'RecordStoreFundingPayment', entityId: payment.id,
    after: { amountCents: payment.amountCents, totalBalanceCents: result.totalBalanceCents }, correlationId,
  });

  // If this payment was tied to a specific order, let the existing
  // deposit-satisfied/activation logic pick it up immediately — reused
  // as-is rather than duplicated (see refreshFundingStatus above).
  if (payment.recordStoreSubscriptionId) {
    await refreshFundingStatus(payment.recordStoreSubscriptionId, correlationId);
  }

  return { success: true, payment: updated };
}

// Finds every funding payment still owed a real Boberdoo credit (a fresh
// webhook delivery, or anything left over from a prior failed attempt)
// and submits each one. Safe to call repeatedly — submitFundingPayment
// itself treats an already-SUBMITTED row as a no-op.
async function submitPendingFundingPayments(correlationId) {
  const pending = await prisma.recordStoreFundingPayment.findMany({ where: { status: { in: ['PENDING_SUBMIT', 'FAILED'] } } });
  const results = [];
  for (const payment of pending) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await submitFundingPayment(payment.id, correlationId));
  }
  return results;
}

module.exports = {
  FRIENDLY_ERROR,
  refreshAgencyBalance,
  listSources,
  checkBalanceForAdditionalProduct,
  createOrder,
  createSubscriptionFromQuote,
  provisionSubscription,
  refreshFundingStatus,
  isInitialDepositSatisfied,
  activateSubscription,
  pauseSubscription,
  resumeSubscription,
  pauseAccount,
  resumeAccount,
  resetAgencyRecordStore,
  changeDailyVolume,
  updateAcceptedSources,
  linkExistingPartner,
  importExistingFilterSet,
  submitFundingPayment,
  submitPendingFundingPayments,
};
