// Inbound Boberdoo lead-delivery webhook — this is the "dynamic EvenFlow
// delivery for Record Store leads" integration. When a Record Store
// Partner's filter set matches and sells a lead, Boberdoo is configured
// (in the live Boberdoo account, outside this codebase — see
// docs/lead-portal-api-reference.md) to POST it here instead of emailing
// it, so it becomes a real EvenFlow Lead. "Dynamic" means this one
// endpoint routes every delivery to the correct Agency automatically, by
// matching the delivery's Partner ID against Agency.boberdooPartnerId —
// never a per-agency URL or hardcoded mapping.
//
// Public (no user session — Boberdoo itself calls this), gated on a
// shared secret the same way routes/emailWebhook.js gates Brevo: unset
// secret -> honest 503 NOT_CONFIGURED, never a silent accept.
//
// Boberdoo's exact posted field names were never confirmed against a real
// delivery before this shipped (no sandbox delivery test was possible —
// see recordStoreProvisioning.js's own Accepted_Sources/TYPE/Daily_Limit
// field names, which WERE confirmed live this same way, by reading real
// validation errors one call at a time). So every field lookup below
// tries several real-world Boberdoo naming conventions, and the full raw
// body is always logged to ApiTransaction first — so the very first live
// delivery can be read back and firstOf()'s candidate lists corrected if
// needed, without ever losing the lead itself (every path still
// acknowledges with 200, and an unroutable delivery alerts Platform
// Owners instead of silently vanishing).
const express = require('express');
const { prisma } = require('../lib/db');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { scoreLead } = require('../lib/priority');
const { notifyAgencyOwners, notifyPlatformOwners } = require('../lib/notifications');

const router = express.Router();

// Boberdoo Lead_Type IDs confirmed against the real account this
// integration targets (see docs/lead-portal-api-reference.md) mapped to
// the Lead.product this delivery creates. A plain data map, not a
// per-type branch, so a future lead type is a one-line addition.
const LEAD_TYPE_TO_PRODUCT = {
  23: 'Auto',
  21: 'Home',
  19: 'Life',
};

function firstOf(body, keys) {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return undefined;
}

async function logDelivery({ resultCode, leadId, errorCode, rawPayload, startedAt }) {
  try {
    await prisma.apiTransaction.create({
      data: {
        vendorId: null,
        method: 'POST',
        endpoint: '/api/webhooks/boberdoo',
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
        resultCode,
        leadId: leadId || null,
        errorCode: errorCode || null,
        rawPayload: rawPayload || null,
      },
    });
  } catch (err) {
    // Logging failure must never break Boberdoo's delivery response.
    console.error('[boberdooDelivery] failed to log transaction', err.message);
  }
}

function isAuthorized(req) {
  const expected = process.env.BOBERDOO_DELIVERY_SECRET;
  if (!expected) return false;
  const provided = req.query.secret;
  return typeof provided === 'string' && provided === expected;
}

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!process.env.BOBERDOO_DELIVERY_SECRET) {
    return res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'BOBERDOO_DELIVERY_SECRET is not set.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }

  // Always 200 once authenticated — a non-2xx here makes Boberdoo
  // retry-storm the same lead. Every failure case below instead logs to
  // ApiTransaction and, when a real lead went unrouted, alerts Platform
  // Owners so it gets fixed without the sale disappearing silently.
  const respondOk = (extra) => res.status(200).json({ success: true, ...extra });

  const partnerId = firstOf(body, ['Partner_ID', 'PartnerID', 'partner_id', 'partnerId']);
  const leadTypeId = firstOf(body, ['TYPE', 'Lead_Type_ID', 'LeadType', 'lead_type_id', 'leadTypeId']);
  // Some Boberdoo "Delivery Mapping" field labels use a literal space
  // (e.g. "Lead ID", "Filter Set ID") rather than underscores — confirmed
  // 2026-10-22 against a real account's Custom Delivery Wizard — so both
  // forms are tried.
  const externalLeadId = firstOf(body, ['Lead_ID', 'Lead ID', 'LeadID', 'lead_id', 'leadId', 'Ping_ID', 'Post_ID']);
  const filterSetId = firstOf(body, ['Filter_Set_ID', 'Filter Set ID', 'FilterSetID', 'filter_set_id', 'filterSetId']);
  // The raw source code this lead matched under (e.g. "Fidadto") — the
  // one field recordStoreSourcePerformance.js's per-source reporting and
  // the 30-day auto-optimization sweep are built on. Never shown to any
  // user directly; always decoded through lib/recordStoreSourceLabels.js.
  const sourceCode = firstOf(body, ['SRC', 'Source', 'source', 'Src']);

  if (!partnerId) {
    await logDelivery({ resultCode: 'MISSING_PARTNER_ID', rawPayload: body, startedAt });
    await notifyPlatformOwners(null, {
      type: 'record_store.delivery_failed',
      severity: 'ACTION',
      title: 'Record Store lead delivery missing Partner ID',
      body: 'A lead was posted to the Record Store delivery webhook with no recognizable Partner ID field. Check the raw payload in the ApiTransaction log.',
    });
    return respondOk({ warning: 'MISSING_PARTNER_ID' });
  }

  const agency = await prisma.agency.findFirst({ where: { boberdooPartnerId: partnerId } });
  if (!agency) {
    await logDelivery({ resultCode: 'UNKNOWN_PARTNER', rawPayload: body, startedAt });
    await notifyPlatformOwners(null, {
      type: 'record_store.delivery_failed',
      severity: 'ACTION',
      title: 'Record Store lead delivery — unknown Partner ID',
      body: `No agency found with boberdooPartnerId "${partnerId}". Check the raw payload in the ApiTransaction log.`,
    });
    return respondOk({ warning: 'UNKNOWN_PARTNER' });
  }

  const product = LEAD_TYPE_TO_PRODUCT[Number(leadTypeId)] || null;

  // Attribute this delivery back to the specific lead program (Record-
  // StoreSubscription) that bought it — precisely, by Filter_Set_ID when
  // the delivery includes one (the normal case); otherwise a best-effort
  // match on agency + product category, so performance reporting still
  // has *something* to group by even on an older/minimal delivery
  // payload. Never blocks lead creation either way — a lead with no
  // resolvable subscription still gets created, just without source-
  // performance attribution.
  let subscriptionId = null;
  if (filterSetId) {
    const bySubscription = await prisma.recordStoreSubscription.findFirst({
      where: { agencyId: agency.id, boberdooFilterSetId: filterSetId },
    });
    subscriptionId = bySubscription?.id || null;
  }
  if (!subscriptionId && product) {
    const byProduct = await prisma.recordStoreSubscription.findFirst({
      where: {
        agencyId: agency.id,
        status: { notIn: ['CANCELLED', 'ERROR'] },
        template: { productCategory: { equals: product.toUpperCase(), mode: 'insensitive' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    subscriptionId = byProduct?.id || null;
  }

  const firstName = firstOf(body, ['First_Name', 'FirstName', 'first_name', 'firstName']) || 'Unknown';
  const lastName = firstOf(body, ['Last_Name', 'LastName', 'last_name', 'lastName']) || 'Lead';
  const email = firstOf(body, ['Email', 'Email_Address', 'email']);
  const phone = firstOf(body, ['Primary_Phone', 'Phone_Home', 'Phone', 'Phone_Number', 'phone']);
  const address = firstOf(body, ['Address', 'Street_Address', 'address']);
  const city = firstOf(body, ['City', 'city']);
  const state = firstOf(body, ['State', 'state']);
  const zip = firstOf(body, ['Zip_Code', 'Zip', 'zip', 'zipcode']);

  // Idempotency: Boberdoo retries a delivery on anything but a clean 200,
  // and Lead's own vendorId+externalLeadId unique index assumes a real
  // Vendor row (which a Record Store delivery never has, vendorId is
  // null) — so dedup is a manual lookup here instead.
  if (externalLeadId) {
    const existing = await prisma.lead.findFirst({
      where: { agencyId: agency.id, source: 'record_store:boberdoo', externalLeadId },
    });
    if (existing) {
      await logDelivery({ resultCode: 'DUPLICATE', leadId: existing.id, rawPayload: body, startedAt });
      return respondOk({ duplicate: true, leadId: existing.id });
    }
  }

  try {
    const phoneNormalized = normalizePhone(phone);
    const normalizedEmail = normalizeEmail(email);

    const result = await prisma.$transaction(async (tx) => {
      let customer = null;
      if (phoneNormalized || normalizedEmail) {
        customer = await tx.customer.findFirst({
          where: {
            OR: [phoneNormalized ? { phoneNormalized } : undefined, normalizedEmail ? { email: normalizedEmail } : undefined].filter(Boolean),
          },
        });
      }
      if (!customer) {
        customer = await tx.customer.create({
          data: { firstName, lastName, phoneNormalized, email: normalizedEmail, address, city, state, zip },
        });
      }

      // Phone-number-level suppression (TCPA) — see leads.js's
      // createLeadRecord for the full reasoning. A Record Store delivery
      // for an already-suppressed Customer is never distributed.
      const isSuppressed = customer.doNotContact;

      const lead = await tx.lead.create({
        data: {
          agencyId: agency.id,
          customerId: customer.id,
          externalLeadId: externalLeadId || null,
          rawPayload: body,
          source: 'record_store:boberdoo',
          product: product || 'Unknown',
          status: isSuppressed ? 'DO_NOT_CONTACT' : 'NEW',
          archivedAt: isSuppressed ? new Date() : null,
          leadType: 'DATA_LEAD',
          address,
          city,
          state,
          zip,
          recordStoreSourceCode: sourceCode || null,
          recordStoreSubscriptionId: subscriptionId,
        },
      });

      const agencyRow = await tx.agency.findUnique({ where: { id: agency.id }, select: { priorityRules: true } });
      const { priorityScore, priorityReason } = scoreLead(lead, agencyRow?.priorityRules);
      const updatedLead = await tx.lead.update({ where: { id: lead.id }, data: { priorityScore, priorityReason } });

      await tx.leadEvent.create({
        data: {
          leadId: lead.id,
          type: 'lead.created.record_store',
          toStatus: updatedLead.status,
          metadata: {
            boberdooPartnerId: partnerId,
            boberdooLeadTypeId: leadTypeId || null,
            sourceCode: sourceCode || null,
            ...(isSuppressed ? { suppressedReason: customer.doNotContactReason || 'Customer marked DO_NOT_CONTACT' } : {}),
          },
        },
      });

      return { lead: updatedLead, isSuppressed };
    });

    await logDelivery({ resultCode: 'SUCCESS', leadId: result.lead.id, rawPayload: body, startedAt });

    if (!result.isSuppressed) {
      await notifyAgencyOwners(agency.id, {
        type: 'lead.new',
        severity: 'INFO',
        title: 'New Record Store lead delivered',
        body: `${firstName} ${lastName}${product ? ' — ' + product : ''}`,
        relatedEntityType: 'Lead',
        relatedEntityId: result.lead.id,
      });
    }

    return respondOk({ leadId: result.lead.id });
  } catch (err) {
    console.error('[boberdooDelivery] failed to create lead', err.message);
    await logDelivery({ resultCode: 'ERROR', errorCode: 'INTERNAL_ERROR', rawPayload: body, startedAt });
    await notifyPlatformOwners(null, {
      type: 'record_store.delivery_failed',
      severity: 'ACTION',
      title: 'Record Store lead delivery failed',
      body: `Lead creation failed for agency ${agency.name}: ${err.message}`,
    });
    return respondOk({ warning: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
