const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { sendInvitationEmail } = require('../lib/email');
const { issuePasswordResetEmail } = require('../lib/auth');
const { reissueInvitation } = require('../lib/invitations');
const { syncSeatCountForAgency } = require('../lib/seatBilling');
const { explainScore, componentPlaceholders } = require('../lib/flowScore');
const { computeFunnel } = require('../lib/funnelMetrics');
const { computeVendorBreakdown, computeProductBreakdown } = require('../lib/performanceBreakdown');
const { save, read } = require('../lib/storage');
const { validateImageUpload } = require('../lib/fileValidation');

const router = express.Router();
router.use(requireAuth);

const backgroundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Personalize page — every user's own account, never another user's
// (no :userId param at all here, always req.user.id, so there is no IDOR
// surface to guard). Mirrors calls.js's upload/read-back shape: the image
// bytes live in lib/storage.js, the DB stores only the storage key, and
// the bytes are streamed back through an authenticated GET, never a
// public/static URL.
router.post('/me/background', backgroundUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'No file uploaded (expected multipart field "image").' });
    }
    const validation = validateImageUpload(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: 'INVALID_FILE', message: validation.reason });
    }

    let storageKey;
    try {
      storageKey = await save(req.file.buffer, req.file.originalname);
    } catch (err) {
      return res.status(500).json({ success: false, error: 'STORAGE_ERROR', message: err.message });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { backgroundImageStorageKey: storageKey, backgroundImageMimeType: validation.detectedType },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'user.background_image_uploaded', entityType: 'User', entityId: req.user.id,
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, hasBackgroundImage: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me/background', async (req, res, next) => {
  try {
    if (!req.user.backgroundImageStorageKey) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    const buffer = await read(req.user.backgroundImageStorageKey);
    res.set('Content-Type', req.user.backgroundImageMimeType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.delete('/me/background', async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { backgroundImageStorageKey: null, backgroundImageMimeType: null },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'user.background_image_removed', entityType: 'User', entityId: req.user.id,
      correlationId: req.correlationId,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const personalizeSchema = z.object({
  fallingEffect: z.enum(['NONE', 'HEARTS', 'STARS', 'SNOW', 'MONEY', 'BUBBLES', 'CONFETTI', 'FIRE']),
});

router.patch('/me/personalize', async (req, res, next) => {
  try {
    const parsed = personalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { fallingEffect: parsed.data.fallingEffect },
    });
    return res.json({ success: true, fallingEffect: updated.fallingEffect });
  } catch (err) {
    next(err);
  }
});

// List users in the caller's own agency (or, for Platform Owner, filterable by agencyId).
router.get('/', async (req, res, next) => {
  try {
    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.query.agencyId || undefined;
    } else {
      agencyId = req.user.agencyId;
      // A non-Platform-Owner with no agencyId (e.g. a Telemarketer, who
      // isn't tied to one agency) must never fall through to an
      // unscoped `where: {}` — that would leak every user platform-wide.
      // Same pattern leads.js already uses for the equivalent case.
      if (!agencyId) return res.json({ success: true, users: [] });
    }
    const users = await prisma.user.findMany({
      where: agencyId ? { agencyId } : {},
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        status: true, agencyId: true, createdAt: true, phone: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
});

const inviteSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['AGENCY_MANAGER', 'PRODUCER']),
});

// Agency Owner/Manager invites a Producer or Manager into THEIR OWN agency only.
router.post('/invite', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED', message: 'An agency is required to send this invite.' });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'EMAIL_IN_USE', message: 'A user with that email already exists.' });
    }

    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND', message: 'That agency could not be found.' });

    const { user, rawToken } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          role: parsed.data.role,
          status: 'INVITED',
          agencyId,
          invitedById: req.user.id,
        },
      });
      const rawToken = crypto.randomBytes(24).toString('hex');
      await tx.invitation.create({
        data: {
          email,
          role: parsed.data.role,
          token: rawToken,
          agencyId,
          invitedById: req.user.id,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, rawToken };
    });

    const emailResult = await sendInvitationEmail({
      to: email,
      role: parsed.data.role,
      agencyName: agency.name,
      token: rawToken,
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'user.invited',
      entityType: 'User',
      entityId: user.id,
      after: { email, role: parsed.data.role },
      correlationId: req.correlationId,
    });

    return res.status(201).json({
      success: true,
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      emailStatus: emailResult.status,
      acceptUrl: emailResult.acceptUrl,
    });
  } catch (err) {
    next(err);
  }
});

// Reissue + resend a still-pending invitation (new token, new 7-day expiry).
router.post('/:userId/resend-invite', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (target.status === 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'ALREADY_ACTIVE', message: 'This user has already activated their account.' });
    }

    const agency = target.agencyId ? await prisma.agency.findUnique({ where: { id: target.agencyId } }) : null;

    const rawToken = await prisma.$transaction((tx) =>
      reissueInvitation(tx, { userId: target.id, email: target.email, role: target.role, agencyId: target.agencyId, invitedById: req.user.id })
    );

    const emailResult = await sendInvitationEmail({ to: target.email, role: target.role, agencyName: agency ? agency.name : 'EvenFlow', token: rawToken });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.invite_resent', entityType: 'User', entityId: target.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, emailStatus: emailResult.status, acceptUrl: emailResult.acceptUrl });
  } catch (err) {
    next(err);
  }
});

// Admin-triggered password reset — an owner/manager/platform owner sends a
// real reset link on a user's behalf (e.g. the user is locked out and can't
// use self-service /auth/forgot-password themselves). Shares the exact same
// token-issue + email-send path as that self-service route via
// issuePasswordResetEmail — never a second implementation.
router.post('/:userId/send-password-reset', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (target.status !== 'ACTIVE') {
      return res.status(409).json({
        success: false,
        error: 'NOT_ACTIVE',
        message: 'This user has not activated their account yet — resend their invite instead.',
      });
    }

    const emailResult = await issuePasswordResetEmail(target);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.password_reset_sent', entityType: 'User', entityId: target.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, emailStatus: emailResult.status, resetUrl: emailResult.resetUrl });
  } catch (err) {
    next(err);
  }
});

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
});

// Fix a typo'd name, or keep a producer's real contact number on file — no
// edit of any kind existed on a user record after invite before this
// (email/role intentionally stay out of scope here).
router.patch('/:userId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.user.update({ where: { id: target.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.updated', entityType: 'User', entityId: target.id,
      before: { firstName: target.firstName, lastName: target.lastName, phone: target.phone },
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, user: { id: updated.id, firstName: updated.firstName, lastName: updated.lastName, phone: updated.phone } });
  } catch (err) {
    next(err);
  }
});

// Coaching notes are kept on the producer, not on any one lead — a
// separate, freeform record an Owner/Manager builds up over time.
async function assertCanManageProducer(req, userId) {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { error: 'NOT_FOUND' };
  if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
    return { error: 'FORBIDDEN' };
  }
  return { target };
}

router.get('/:userId/notes', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const { target, error } = await assertCanManageProducer(req, req.params.userId);
    if (error) return res.status(error === 'NOT_FOUND' ? 404 : 403).json({ success: false, error });

    const notes = await prisma.producerNote.findMany({
      where: { producerId: target.id },
      include: { author: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, notes });
  } catch (err) {
    next(err);
  }
});

const createNoteSchema = z.object({ content: z.string().min(1) });

router.post('/:userId/notes', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { target, error } = await assertCanManageProducer(req, req.params.userId);
    if (error) return res.status(error === 'NOT_FOUND' ? 404 : 403).json({ success: false, error });
    if (!target.agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const note = await prisma.producerNote.create({
      data: { producerId: target.id, agencyId: target.agencyId, authorId: req.user.id, content: parsed.data.content },
      include: { author: { select: { firstName: true, lastName: true } } },
    });
    return res.status(201).json({ success: true, note });
  } catch (err) {
    next(err);
  }
});

// Deactivate a user — preserves all historical attribution, just blocks login.
router.post('/:userId/deactivate', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: target.agencyId,
      action: 'user.deactivated',
      entityType: 'User',
      entityId: target.id,
      before: { status: target.status },
      after: { status: updated.status },
      correlationId: req.correlationId,
    });
    if (target.agencyId) await syncSeatCountForAgency(target.agencyId);
    return res.json({ success: true, user: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
});

// Full KPI breakdown for one Producer/Telemarketer — Flow Score + why,
// funnel, per-vendor and per-lead-type numbers, all for one date range.
// Used both by "My Leads" (a producer viewing their own id) and the
// Agency Owner's Producer Detail drill-down (any producer in their own
// agency). Reuses the exact same funnel/breakdown functions either way —
// no second implementation for "my own numbers" vs "someone else's".
router.get('/:userId/performance', async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const isSelf = target.id === req.user.id;
    if (!isSelf && req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!['PRODUCER', 'TELEMARKETER'].includes(target.role)) {
      return res.status(400).json({ success: false, error: 'NOT_APPLICABLE', message: 'Performance breakdown applies to Producers and Telemarketers.' });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);

    const snapshot = await prisma.flowScoreSnapshot.findFirst({
      where: { subjectType: 'USER', subjectId: target.id },
      orderBy: { computedAt: 'desc' },
    });

    // A Telemarketer has no agencyId of their own — vendor/product
    // breakdown is a per-agency-lead-source concept that doesn't apply to
    // them the same way (their own dedicated performance view is
    // GET /telemarketers/:id/performance instead).
    const agencyId = target.agencyId;
    const [funnel, vendorBreakdown, productBreakdown] = agencyId
      ? await Promise.all([
          computeFunnel({ agencyId, userId: target.id, from, to }),
          computeVendorBreakdown({ agencyId, userId: target.id, from, to }),
          computeProductBreakdown({ agencyId, userId: target.id, from, to }),
        ])
      : [null, [], []];

    return res.json({
      success: true,
      user: { id: target.id, firstName: target.firstName, lastName: target.lastName, role: target.role, email: target.email, phone: target.phone },
      period: { from: from.toISOString(), to: to.toISOString() },
      snapshot,
      explanation: snapshot ? explainScore(snapshot) : null,
      componentPlaceholders: snapshot ? null : componentPlaceholders(target.role),
      funnel,
      vendorBreakdown,
      productBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
