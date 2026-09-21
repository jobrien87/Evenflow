// The one persistent, agency-wide team room — unlike a Lead/Transfer
// thread's fixed 2-3 stakeholders, this room's membership is derived live
// from real, changing agency state (active users, active telemarketer
// assignments) rather than a static participant list, so it needs its own
// sync step beyond getOrCreateEntityConversation's "add missing" logic.

const { prisma } = require('./db');
const { getOrCreateEntityConversation } = require('./chat');

// Every currently-real member of an agency's team room: any ACTIVE user
// whose agencyId matches (covers AGENCY_OWNER/AGENCY_MANAGER/PRODUCER —
// any agency-scoped role, no need to hardcode which ones) union every
// Telemarketer with an ACTIVE TelemarketerAssignment to this agency (TMs
// never have User.agencyId set — same real membership rule the transfer
// routing engine already used).
async function agencyChatParticipantIds(agencyId) {
  const [agencyUsers, tmAssignments] = await Promise.all([
    prisma.user.findMany({ where: { agencyId, status: 'ACTIVE' }, select: { id: true } }),
    prisma.telemarketerAssignment.findMany({ where: { agencyId, status: 'ACTIVE' }, select: { telemarketerId: true } }),
  ]);
  return [...new Set([...agencyUsers.map((u) => u.id), ...tmAssignments.map((a) => a.telemarketerId)])];
}

// Get-or-create the agency's one team-room Conversation, then reconcile
// its real participants both ways: add anyone newly eligible (reusing
// getOrCreateEntityConversation's existing add-only logic) and remove
// anyone no longer eligible (a deactivated Producer, an ended TM
// assignment) — access is revoked on the very next call, not left stale.
async function getOrSyncAgencyConversation(agencyId) {
  const participantUserIds = await agencyChatParticipantIds(agencyId);

  let conversation = await getOrCreateEntityConversation({
    agencyId,
    entityType: 'AGENCY',
    entityId: agencyId,
    participantUserIds,
  });

  const desired = new Set(participantUserIds);
  const staleIds = conversation.participants.map((p) => p.userId).filter((id) => !desired.has(id));
  if (staleIds.length > 0) {
    await prisma.conversationParticipant.deleteMany({
      where: { conversationId: conversation.id, userId: { in: staleIds } },
    });
    conversation = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: { participants: true } });
  }

  return conversation;
}

module.exports = { agencyChatParticipantIds, getOrSyncAgencyConversation };
