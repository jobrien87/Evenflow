const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { getOrCreateEntityConversation, isParticipant, postMessage, markRead } = require('../lib/chat');
const { getOrSyncAgencyConversation } = require('../lib/agencyChat');

const router = express.Router();
router.use(requireAuth);

// The caller's own conversations, most-recent first, with the last message
// for a preview.
router.get('/conversations', async (req, res, next) => {
  try {
    const participantRows = await prisma.conversationParticipant.findMany({
      where: { userId: req.user.id },
      select: { conversationId: true, lastReadAt: true },
    });
    const conversationIds = participantRows.map((p) => p.conversationId);
    if (conversationIds.length === 0) return res.json({ success: true, conversations: [] });

    const conversations = await prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    const lastReadByConvo = Object.fromEntries(participantRows.map((p) => [p.conversationId, p.lastReadAt]));

    return res.json({
      success: true,
      conversations: conversations.map((c) => ({
        id: c.id,
        relatedEntityType: c.relatedEntityType,
        relatedEntityId: c.relatedEntityId,
        lastMessage: c.messages[0] || null,
        unread: c.messages[0] ? c.messages[0].createdAt > (lastReadByConvo[c.id] || new Date(0)) : false,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Get-or-create the thread for a specific Lead/Transfer, or the one
// persistent team room for an Agency (entityId is the agencyId itself).
// Tenant-scoped via the entity's own agencyId — never trust a
// client-supplied agencyId for Lead/Transfer; for AGENCY the entityId IS
// the agencyId, so the tenant check below is what does the real gating.
router.get('/conversations/entity/:entityType/:entityId', async (req, res, next) => {
  try {
    const entityType = req.params.entityType.toUpperCase();
    if (!['LEAD', 'TRANSFER', 'AGENCY'].includes(entityType)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'entityType must be LEAD, TRANSFER, or AGENCY.' });
    }

    if (entityType === 'AGENCY') {
      const agencyId = req.params.entityId;
      let allowed = req.user.role === 'PLATFORM_OWNER' || req.user.agencyId === agencyId;
      if (!allowed && req.user.role === 'TELEMARKETER') {
        const assignment = await prisma.telemarketerAssignment.findFirst({
          where: { telemarketerId: req.user.id, agencyId, status: 'ACTIVE' },
        });
        allowed = !!assignment;
      }
      if (!allowed) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

      const conversation = await getOrSyncAgencyConversation(agencyId);
      return res.json({ success: true, conversation: { id: conversation.id, relatedEntityType: conversation.relatedEntityType, relatedEntityId: conversation.relatedEntityId } });
    }

    let agencyId, participantUserIds;
    if (entityType === 'TRANSFER') {
      const transfer = await prisma.transfer.findUnique({ where: { id: req.params.entityId } });
      if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      agencyId = transfer.agencyId;
      participantUserIds = [transfer.createdByTMId, transfer.acceptedById, req.user.id].filter(Boolean);
    } else {
      const lead = await prisma.lead.findUnique({ where: { id: req.params.entityId } });
      if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      agencyId = lead.agencyId;
      participantUserIds = [lead.assignedToId, lead.createdById, req.user.id].filter(Boolean);
    }

    if (!agencyId || (req.user.role !== 'PLATFORM_OWNER' && agencyId !== req.user.agencyId)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const conversation = await getOrCreateEntityConversation({
      agencyId,
      entityType,
      entityId: req.params.entityId,
      participantUserIds,
    });

    return res.json({ success: true, conversation: { id: conversation.id, relatedEntityType: conversation.relatedEntityType, relatedEntityId: conversation.relatedEntityId } });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const messages = await prisma.message.findMany({
      where: { conversationId: req.params.id },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    await markRead(req.params.id, req.user.id).catch(() => {});
    return res.json({ success: true, messages });
  } catch (err) {
    next(err);
  }
});

const postSchema = z.object({ content: z.string().min(1).max(4000) });

router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const message = await postMessage({ conversationId: req.params.id, authorId: req.user.id, content: parsed.data.content });
    return res.status(201).json({ success: true, message });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
