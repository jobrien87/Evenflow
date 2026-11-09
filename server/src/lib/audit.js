const { prisma } = require('./db');
const { getContext } = require('./requestContext');

async function recordAudit({
  actorId = null,
  actorRole = null,
  agencyId = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  metadata = null,
  correlationId = null,
}) {
  // actorId/actorRole stay whatever the caller passed — almost always
  // req.user, the EFFECTIVE identity (the agency owner being viewed as),
  // so every existing audit reader keeps seeing "who this looks like it
  // was" unchanged. metadata.impersonatedBy is the one thing layered on
  // top, automatically, whenever the request that triggered this action is
  // an active impersonation — it's where the real actor (the Platform
  // Owner) is recorded, with no change needed at any of this function's
  // many call sites. See middleware/auth.js's attachUser.
  const ctx = getContext();
  const finalMetadata = ctx?.isImpersonating
    ? { ...(metadata || {}), impersonatedBy: ctx.impersonatedBy }
    : metadata;

  return prisma.auditEvent.create({
    data: {
      actorId,
      actorRole,
      agencyId,
      action,
      entityType,
      entityId,
      before,
      after,
      metadata: finalMetadata,
      correlationId,
    },
  });
}

module.exports = { recordAudit };
