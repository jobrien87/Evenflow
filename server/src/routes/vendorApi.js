const express = require('express');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../lib/db');
const { requireVendorAuth } = require('../middleware/vendorAuth');
const { checkVendorRateLimit } = require('../lib/vendorRateLimit');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { scoreLead } = require('../lib/priority');
const { recordAudit } = require('../lib/audit');
const { recordVendorLeadCost } = require('../lib/financialEvents');
const { notifyAgencyOwners } = require('../lib/notifications');

const router = express.Router();

const postSchema = z.object({
  external_lead_id: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  state: z.string().length(2),
  zip: z.string().optional(),
  product: z.string().min(1),
  current_carrier: z.string().optional(),
  consent_timestamp: z.string().datetime().optional(),
  source: z.string().optional(),
  sub_id: z.string().optional(),
});

async function logTransaction({ vendorId, method, endpoint, statusCode, startedAt, resultCode, leadId, errorCode, correlationId, rawPayload }) {
  try {
    await prisma.apiTransaction.create({
      data: {
        vendorId,
        method,
        endpoint,
        statusCode,
        latencyMs: Date.now() - startedAt,
        resultCode,
        leadId: leadId || null,
        errorCode: errorCode || null,
        correlationId,
        rawPayload: rawPayload || null,
      },
    });
  } catch (err) {
    // Logging failure must never break the vendor-facing response.
    console.error('[vendorApi] failed to log transaction', err.message);
  }
}

// POST /api/v1/leads — the Direct POST endpoint.
router.post('/leads', requireVendorAuth, async (req, res) => {
  const startedAt = Date.now();
  const correlationId = req.correlationId || uuidv4();
  const endpoint = '/api/v1/leads';

  if (!checkVendorRateLimit(req.vendor.id)) {
    await logTransaction({ vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 429, startedAt, resultCode: 'RATE_LIMITED', correlationId, rawPayload: req.body });
    return res.status(429).json({ success: false, error: 'RATE_LIMITED', correlation_id: correlationId });
  }

  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    await logTransaction({
      vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 400, startedAt,
      resultCode: 'VALIDATION_ERROR', errorCode: 'VALIDATION', correlationId, rawPayload: req.body,
    });
    return res.status(400).json({ success: false, error: 'VALIDATION', field_errors: parsed.error.flatten().fieldErrors, correlation_id: correlationId });
  }

  const data = parsed.data;

  if (data.product !== req.vendor.product) {
    await logTransaction({
      vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 400, startedAt,
      resultCode: 'PRODUCT_MISMATCH', errorCode: 'PRODUCT_MISMATCH', correlationId, rawPayload: req.body,
    });
    return res.status(400).json({
      success: false, error: 'PRODUCT_MISMATCH',
      message: `This vendor connection is configured for product "${req.vendor.product}", not "${data.product}".`,
      correlation_id: correlationId,
    });
  }

  // Idempotency: same vendor + same external_lead_id never creates a second lead.
  const existing = await prisma.lead.findUnique({
    where: { vendorId_externalLeadId: { vendorId: req.vendor.id, externalLeadId: data.external_lead_id } },
  });
  if (existing) {
    await logTransaction({
      vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 200, startedAt,
      resultCode: 'DUPLICATE', leadId: existing.id, correlationId, rawPayload: req.body,
    });
    return res.status(200).json({
      success: false, error: 'DUPLICATE', duplicate: true,
      existing_lead_id: existing.id, timestamp: new Date().toISOString(), correlation_id: correlationId,
    });
  }

  try {
    const phoneNormalized = normalizePhone(data.phone);
    const email = normalizeEmail(data.email);

    const result = await prisma.$transaction(async (tx) => {
      let customer = null;
      if (phoneNormalized || email) {
        customer = await tx.customer.findFirst({
          where: { OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean) },
        });
      }
      if (!customer) {
        customer = await tx.customer.create({
          data: {
            firstName: data.first_name,
            lastName: data.last_name,
            phoneNormalized,
            email,
            state: data.state,
            zip: data.zip,
          },
        });
      }

      const lead = await tx.lead.create({
        data: {
          agencyId: req.vendor.agencyId,
          customerId: customer.id,
          vendorId: req.vendor.id,
          externalLeadId: data.external_lead_id,
          rawPayload: req.body,
          source: `vendor:${req.vendor.name}`,
          product: data.product,
          status: 'NEW',
          customFields: {
            currentCarrier: data.current_carrier,
            subId: data.sub_id,
            consentTimestamp: data.consent_timestamp,
          },
        },
      });

      const { priorityScore, priorityReason } = scoreLead(lead);
      const updatedLead = await tx.lead.update({ where: { id: lead.id }, data: { priorityScore, priorityReason } });

      await tx.leadEvent.create({
        data: { leadId: lead.id, type: 'lead.created.vendor_api', toStatus: 'NEW', metadata: { vendorId: req.vendor.id } },
      });

      return updatedLead;
    });

    await logTransaction({
      vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 201, startedAt,
      resultCode: 'SUCCESS', leadId: result.id, correlationId, rawPayload: req.body,
    });

    await recordAudit({
      agencyId: req.vendor.agencyId,
      action: 'lead.created.vendor_api',
      entityType: 'Lead',
      entityId: result.id,
      after: { vendorId: req.vendor.id, product: data.product },
      correlationId,
    });

    // Record the real vendor lead cost, if this vendor connection has one configured.
    await recordVendorLeadCost(result, req.vendor);

    await notifyAgencyOwners(req.vendor.agencyId, {
      type: 'lead.new',
      severity: 'INFO',
      title: `New lead from ${req.vendor.name}`,
      body: `${data.first_name} ${data.last_name} — ${data.product}`,
      relatedEntityType: 'Lead',
      relatedEntityId: result.id,
    });

    return res.status(201).json({
      success: true,
      lead_id: result.id,
      status: result.status,
      timestamp: result.createdAt.toISOString(),
      correlation_id: correlationId,
    });
  } catch (err) {
    console.error(`[vendorApi] error correlationId=${correlationId}`, err);
    await logTransaction({
      vendorId: req.vendor.id, method: 'POST', endpoint, statusCode: 500, startedAt,
      resultCode: 'INTERNAL_ERROR', errorCode: 'INTERNAL_ERROR', correlationId, rawPayload: req.body,
    });
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', correlation_id: correlationId });
  }
});

module.exports = router;
