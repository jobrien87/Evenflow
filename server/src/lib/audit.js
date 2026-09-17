const { prisma } = require('./db');

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
      metadata,
      correlationId,
    },
  });
}

module.exports = { recordAudit };
