// Chat scoped to a real Transfer or Lead — never a generic global chatroom.
// No websockets (this codebase has zero real-time infra anywhere else
// either); the client polls while a thread is open.

const { prisma } = require('./db');
const { notifyUser } = require('./notifications');

// Idempotent: finds the existing thread for this entity if one exists,
// otherwise creates it with the given participants. Any participant not
// already on an existing thread gets added (e.g. an Agency Owner opening
// a thread a telemarketer already started).
async function getOrCreateEntityConversation({ agencyId, entityType, entityId, participantUserIds }) {
  let conversation = await prisma.conversation.findUnique({
    where: { relatedEntityType_relatedEntityId: { relatedEntityType: entityType, relatedEntityId: entityId } },
    include: { participants: true },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        agencyId,
        relatedEntityType: entityType,
        relatedEntityId: entityId,
        participants: { create: [...new Set(participantUserIds)].map((userId) => ({ userId })) },
      },
      include: { participants: true },
    });
  } else {
    const existingIds = new Set(conversation.participants.map((p) => p.userId));
    const missing = [...new Set(participantUserIds)].filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      await prisma.conversationParticipant.createMany({
        data: missing.map((userId) => ({ conversationId: conversation.id, userId })),
        skipDuplicates: true,
      });
      conversation = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: { participants: true } });
    }
  }

  return conversation;
}

// Deterministic regardless of who starts the DM — [a, b].sort() means
// userA DMing userB and userB DMing userA always land on the same
// relatedEntityId, so @@unique([relatedEntityType, relatedEntityId])
// alone gives this the same idempotency getOrCreateEntityConversation
// gets from a real Lead/Transfer id.
function dmEntityId(userAId, userBId) {
  return [userAId, userBId].sort().join(':');
}

// A DM's two participants never change after creation (unlike an agency
// room's live-synced membership), so this is simpler than
// getOrCreateEntityConversation — just find-or-create by the deterministic
// key above.
async function getOrCreateDmConversation({ userAId, userBId, agencyId }) {
  const relatedEntityId = dmEntityId(userAId, userBId);
  let conversation = await prisma.conversation.findUnique({
    where: { relatedEntityType_relatedEntityId: { relatedEntityType: 'DM', relatedEntityId } },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        agencyId,
        relatedEntityType: 'DM',
        relatedEntityId,
        participants: { create: [userAId, userBId].map((userId) => ({ userId })) },
      },
    });
  }
  return conversation;
}

async function isParticipant(conversationId, userId) {
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  return !!row;
}

// The one "virtual participant" role in an AGENCY room — a Platform Owner
// reads/posts there via platformOwnerAgencyBypass (routes/chat.js), never
// a real ConversationParticipant row. Anywhere participants are listed or
// @mentions are validated for an AGENCY conversation has to merge these in
// by hand, or a Platform Owner could never be @mentioned (or notified of
// one) at all.
async function activePlatformOwners() {
  return prisma.user.findMany({
    where: { role: 'PLATFORM_OWNER', status: 'ACTIVE' },
    select: { id: true, firstName: true, lastName: true },
  });
}

// The one curated quick-react set (easy to extend later — emoji stays a
// plain string column, no migration needed to add more). Validated here,
// server-side, rather than trusting any client-supplied string.
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

async function postMessage({ conversationId, authorId, content, replyToId, mentionedUserIds }) {
  // Never trust a client-supplied replyToId as belonging to this
  // conversation — a reply quoting a message from a DIFFERENT conversation
  // would be a real cross-thread data leak (the quoted snippet/author
  // would render for people who were never participants of that other
  // conversation).
  let validReplyToId = null;
  if (replyToId) {
    const replyTo = await prisma.message.findUnique({ where: { id: replyToId }, select: { conversationId: true } });
    if (replyTo && replyTo.conversationId === conversationId) validReplyToId = replyToId;
  }

  const [conversation, author, others] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.user.findUnique({ where: { id: authorId }, select: { firstName: true, lastName: true } }),
    prisma.conversationParticipant.findMany({ where: { conversationId, userId: { not: authorId } } }),
  ]);

  // In an AGENCY room, a Platform Owner can be @mentioned too even though
  // they're never a real participant row (see activePlatformOwners above).
  const platformOwnerIds = conversation?.relatedEntityType === 'AGENCY'
    ? (await activePlatformOwners()).map((u) => u.id)
    : [];

  // Never trust client-supplied mentionedUserIds blindly — only a real
  // participant of THIS conversation, or (in an AGENCY room) an active
  // Platform Owner, can actually be mentioned. Never the author themselves.
  const validMentionIds = [...new Set(mentionedUserIds || [])].filter(
    (id) => id !== authorId && (others.some((p) => p.userId === id) || platformOwnerIds.includes(id))
  );

  const message = await prisma.message.create({
    data: {
      conversationId,
      authorId,
      content,
      replyToId: validReplyToId,
      mentions: { create: validMentionIds.map((userId) => ({ userId })) },
    },
  });

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: authorId } },
    data: { lastReadAt: new Date() },
  }).catch(() => {});

  const replyTitle = validReplyToId
    ? `${author.firstName} ${author.lastName} replied to your message`
    : `New message from ${author.firstName} ${author.lastName}`;
  const mentionTitle = `${author.firstName} ${author.lastName} mentioned you`;
  const body = content.length > 140 ? `${content.slice(0, 140)}…` : content;

  // A Platform Owner validly @mentioned above but not a real participant
  // (see platformOwnerIds) would otherwise never hear about a message that
  // explicitly tagged them — the loop below only covers real participants.
  const othersIds = new Set(others.map((p) => p.userId));
  const mentionOnlyRecipientIds = validMentionIds.filter((id) => !othersIds.has(id));

  Promise.all([
    ...others.map((p) => {
      const mentioned = validMentionIds.includes(p.userId);
      return notifyUser({
        userId: p.userId,
        agencyId: conversation.agencyId,
        type: mentioned ? 'chat.mention' : 'chat.message',
        severity: 'INFO',
        title: mentioned ? mentionTitle : replyTitle,
        body,
        relatedEntityType: conversation.relatedEntityType,
        relatedEntityId: conversation.relatedEntityId,
      });
    }),
    ...mentionOnlyRecipientIds.map((userId) =>
      notifyUser({
        userId,
        agencyId: conversation.agencyId,
        type: 'chat.mention',
        severity: 'INFO',
        title: mentionTitle,
        body,
        relatedEntityType: conversation.relatedEntityType,
        relatedEntityId: conversation.relatedEntityId,
      })
    ),
  ]).catch((err) => console.error('[chat] notify failed', err.message));

  return message;
}

async function markRead(conversationId, userId) {
  return prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });
}

// Toggle semantics: react if this (message, user, emoji) row doesn't
// exist yet, un-react if it does — one endpoint, no separate add/remove
// routes, and no local "did I already react" bookkeeping needed client-side
// beyond what the response says. Returns { reacted: boolean }.
async function toggleReaction({ messageId, userId, emoji }) {
  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });
  if (existing) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
    return { reacted: false };
  }
  await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
  return { reacted: true };
}

module.exports = {
  getOrCreateEntityConversation,
  dmEntityId,
  getOrCreateDmConversation,
  isParticipant,
  activePlatformOwners,
  postMessage,
  markRead,
  toggleReaction,
  REACTION_EMOJI,
};
