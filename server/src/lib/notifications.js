const { prisma } = require('./db');
const { isConfigured, sendEmail } = require('./email');

async function getAgencyOwnerIds(agencyId) {
  const owners = await prisma.user.findMany({
    where: { agencyId, role: { in: ['AGENCY_OWNER', 'AGENCY_MANAGER'] }, status: 'ACTIVE' },
    select: { id: true },
  });
  return owners.map((o) => o.id);
}

async function notifyUser({ userId, agencyId, type, severity = 'INFO', title, body, relatedEntityType, relatedEntityId }) {
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
  const muted = pref && pref.mutedTypes.includes(type) && severity !== 'CRITICAL';
  if (muted) return null;

  const notification = await prisma.notification.create({
    data: { userId, agencyId, type, severity, title, body, relatedEntityType, relatedEntityId },
  });

  // Team-room messages, stale-lead nudges, and speed-to-lead alerts
  // belong in the app only, regardless of severity or email preferences.
  // Lead/Transfer chat and other notification emails keep their existing
  // behavior, including the recipient's email preference.
  const inAppOnly = type === 'lead.stale'
    || type === 'lead.first_attempt_overdue'
    || (type === 'chat.message' && relatedEntityType === 'AGENCY');
  const emailEnabled = !inAppOnly && (!pref || pref.emailEnabled);
  if (emailEnabled && isConfigured()) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (user) {
        await sendEmail({ to: user.email, subject: title, html: `<p>${body || title}</p>` });
      }
    } catch (err) {
      console.error('[notifications] email send failed', err.message);
    }
  }

  return notification;
}

async function notifyUsers(userIds, payload) {
  return Promise.all(userIds.map((userId) => notifyUser({ ...payload, userId })));
}

async function notifyAgencyOwners(agencyId, payload) {
  const ownerIds = await getAgencyOwnerIds(agencyId);
  return notifyUsers(ownerIds, { ...payload, agencyId });
}

module.exports = { notifyUser, notifyUsers, notifyAgencyOwners, getAgencyOwnerIds };
