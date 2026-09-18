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

async function isParticipant(conversationId, userId) {
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  return !!row;
}

async function postMessage({ conversationId, authorId, content }) {
  const message = await prisma.message.create({ data: { conversationId, authorId, content } });

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: authorId } },
    data: { lastReadAt: new Date() },
  }).catch(() => {});

  const [conversation, author, others] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.user.findUnique({ where: { id: authorId }, select: { firstName: true, lastName: true } }),
    prisma.conversationParticipant.findMany({ where: { conversationId, userId: { not: authorId } } }),
  ]);

  Promise.all(
    others.map((p) =>
      notifyUser({
        userId: p.userId,
        agencyId: conversation.agencyId,
        type: 'chat.message',
        severity: 'INFO',
        title: `New message from ${author.firstName} ${author.lastName}`,
        body: content.length > 140 ? `${content.slice(0, 140)}…` : content,
        relatedEntityType: conversation.relatedEntityType,
        relatedEntityId: conversation.relatedEntityId,
      })
    )
  ).catch((err) => console.error('[chat] notify failed', err.message));

  return message;
}

async function markRead(conversationId, userId) {
  return prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });
}

module.exports = { getOrCreateEntityConversation, isParticipant, postMessage, markRead };
