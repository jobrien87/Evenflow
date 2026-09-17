const { prisma } = require('./db');

const IMPERSONATION_COOKIE = 'evenflow_impersonation';

async function resolveImpersonation(realUser, rawLogId) {
  if (!rawLogId || !realUser) return null;

  const log = await prisma.impersonationLog.findUnique({ where: { id: rawLogId } });
  if (!log || log.endedAt) return null;
  if (log.platformOwnerId !== realUser.id) return null;

  const targetUser = await prisma.user.findUnique({ where: { id: log.targetUserId } });
  if (!targetUser || targetUser.status !== 'ACTIVE') return null;

  return { log, targetUser };
}

module.exports = { IMPERSONATION_COOKIE, resolveImpersonation };
