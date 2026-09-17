const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ success: true, notifications });
  } catch (err) {
    next(err);
  }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await prisma.notification.count({ where: { userId: req.user.id, readAt: null } });
    return res.json({ success: true, count });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const notification = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notification) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (notification.userId !== req.user.id) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    const updated = await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
    return res.json({ success: true, notification: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const pref = await prisma.notificationPreference.findUnique({ where: { userId: req.user.id } });
    return res.json({ success: true, preferences: pref || { userId: req.user.id, emailEnabled: true, mutedTypes: [] } });
  } catch (err) {
    next(err);
  }
});

const prefSchema = z.object({
  emailEnabled: z.boolean().optional(),
  mutedTypes: z.array(z.string()).optional(),
});

router.patch('/preferences', async (req, res, next) => {
  try {
    const parsed = prefSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const pref = await prisma.notificationPreference.upsert({
      where: { userId: req.user.id },
      update: parsed.data,
      create: { userId: req.user.id, emailEnabled: parsed.data.emailEnabled ?? true, mutedTypes: parsed.data.mutedTypes ?? [] },
    });
    return res.json({ success: true, preferences: pref });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
