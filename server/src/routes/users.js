const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, canActOnUser } = require('../middleware/auth');
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

// birthday drives lib/useAccountCelebrations.js's yearly celebration —
// the falling-effect picker that used to live at this route is retired
// in favor of real event-driven celebrations (see lib/celebrations.js).
const personalizeSchema = z.object({
  birthday: z.string().date().nullable(),
});

router.patch('/me/personalize', async (req, res, next) => {
  try {
    const parsed = personalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { birthday: parsed.data.birthday ? new Date(parsed.data.birthday) : null },
    });
    return res.json({ success: true, birthday: updated.birthday });
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
        officeId: true, office: { select: { id: true, name: true } }, birthday: true,
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

// Shared by the single-invite and bulk-invite routes below — creates the
// User + Invitation rows in one transaction, sends the real invitation
// email (or returns the honest raw accept link when email isn't
// configured), and records the audit event. Never throws on an
// already-registered email; returns a structured failure instead so a
// bulk batch can report per-row results without one bad row aborting
// the rows around it.
async function inviteOneUser({ actor, agencyId, agency, data, correlationId }) {
  const email = data.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { success: false, email, error: 'EMAIL_IN_USE', message: 'A user with that email already exists.' };
  }

  const { user, rawToken } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role,
        status: 'INVITED',
        agencyId,
        invitedById: actor.id,
      },
    });
    const rawToken = crypto.randomBytes(24).toString('hex');
    await tx.invitation.create({
      data: {
        email,
        role: data.role,
        token: rawToken,
        agencyId,
        invitedById: actor.id,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return { user, rawToken };
  });

  const emailResult = await sendInvitationEmail({
    to: email,
    role: data.role,
    agencyName: agency.name,
    token: rawToken,
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    agencyId,
    action: 'user.invited',
    entityType: 'User',
    entityId: user.id,
    after: { email, role: data.role },
    correlationId,
  });

  return {
    success: true,
    email,
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
    emailStatus: emailResult.status,
  };
}

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
    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND', message: 'That agency could not be found.' });

    const result = await inviteOneUser({ actor: req.user, agencyId, agency, data: parsed.data, correlationId: req.correlationId });
    if (!result.success) {
      return res.status(409).json({ success: false, error: result.error, message: result.message });
    }

    return res.status(201).json({
      success: true,
      user: result.user,
      emailStatus: result.emailStatus,
    });
  } catch (err) {
    next(err);
  }
});

const bulkInviteSchema = z.object({
  invites: z.array(inviteSchema).min(1, 'At least one invite is required.').max(25, 'You can invite up to 25 people at once.'),
});

// Same target-agency/target-role rules as POST /invite, just N rows at
// once. Each row gets its own real transaction + email send via the
// shared inviteOneUser() above — a bad row (e.g. a duplicate email)
// never blocks the rows around it; the response reports a per-row
// result so the client can show exactly which invites went out and
// which need fixing.
router.post('/invite-bulk', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = bulkInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED', message: 'An agency is required to send these invites.' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND', message: 'That agency could not be found.' });

    // Reject duplicate emails within the same batch up front — never trust
    // the client to have deduped its own rows before writing anything.
    const seen = new Set();
    for (const invite of parsed.data.invites) {
      const email = invite.email.trim().toLowerCase();
      if (seen.has(email)) {
        return res.status(400).json({ success: false, error: 'DUPLICATE_EMAIL', message: `"${email}" appears more than once in this batch.` });
      }
      seen.add(email);
    }

    // Sequential, not Promise.all — each row is its own transaction plus a
    // real outbound email; one at a time keeps audit-log ordering sane and
    // avoids hammering the email provider with a burst of sends.
    const results = [];
    for (const invite of parsed.data.invites) {
      results.push(await inviteOneUser({ actor: req.user, agencyId, agency, data: invite, correlationId: req.correlationId }));
    }

    const succeeded = results.filter((r) => r.success).length;
    return res.status(200).json({ success: true, results, succeeded, failed: results.length - succeeded });
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
    // An already-logged-in account can't be the target of its own
    // activation invite — this action only makes sense against someone
    // else's still-pending account. Blocks it explicitly rather than
    // relying on the ALREADY_ACTIVE check below to happen to catch it.
    if (target.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You cannot perform this action on your own account.' });
    }
    // Reissuing an invitation hands out a fresh activation token that sets
    // the target's initial password — same account-takeover risk as a
    // password reset, so the same seniority rule applies.
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
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

    // The raw token is never returned to the browser — only delivered to
    // the target's own inbox. lib/email.js logs the link server-side when
    // email isn't configured or fails, for an operator with real log
    // access to relay manually.
    return res.json({ success: true, emailStatus: emailResult.status });
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
    // Resetting your own password is what self-service /auth/forgot-password
    // is for — this admin path only makes sense against someone else.
    if (target.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Use the self-service "forgot password" flow for your own account.' });
    }
    // Agency membership alone isn't enough — a manager must never be able to
    // reset a peer or superior's password (account takeover). Strictly
    // senior-role-only, same rule as deactivate below.
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
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

    // The raw token is never returned to the browser — only delivered to
    // the target's own inbox, same rationale as resend-invite above.
    return res.json({ success: true, emailStatus: emailResult.status });
  } catch (err) {
    next(err);
  }
});

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  // null explicitly unassigns the producer from any office.
  officeId: z.string().uuid().nullable().optional(),
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
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
    }
    if (parsed.data.officeId) {
      // Never trust a client-supplied officeId blindly — confirm it
      // belongs to the exact same agency as the producer being assigned.
      const office = await prisma.office.findUnique({ where: { id: parsed.data.officeId } });
      if (!office || office.agencyId !== target.agencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'officeId must belong to this producer\'s own agency.' });
      }
    }
    const officeChanging = 'officeId' in parsed.data && parsed.data.officeId !== target.officeId;
    const updated = await prisma.$transaction(async (tx) => {
      if (officeChanging && target.officeId) {
        // A letter claim only means anything at the office it was
        // configured for — if the producer moves (or is unassigned), it
        // must not silently follow them to (or linger at) the old office.
        await tx.officeAlphaAssignment.deleteMany({ where: { officeId: target.officeId, userId: target.id } });
      }
      return tx.user.update({ where: { id: target.id }, data: parsed.data });
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.updated', entityType: 'User', entityId: target.id,
      before: { firstName: target.firstName, lastName: target.lastName, phone: target.phone, officeId: target.officeId },
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, user: { id: updated.id, firstName: updated.firstName, lastName: updated.lastName, phone: updated.phone, officeId: updated.officeId } });
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

// True when deactivating `target` would leave an agency with no active
// AGENCY_OWNER, or the platform with no active PLATFORM_OWNER — either
// one is a real lockout (nobody left who can re-activate anyone, or run
// the agency/platform at all), so deactivation must be refused rather
// than left to be discovered after the fact.
async function isLastActiveOwner(target) {
  if (target.status !== 'ACTIVE') return false;
  if (target.role === 'AGENCY_OWNER') {
    const count = await prisma.user.count({ where: { role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: target.agencyId } });
    return count <= 1;
  }
  if (target.role === 'PLATFORM_OWNER') {
    const count = await prisma.user.count({ where: { role: 'PLATFORM_OWNER', status: 'ACTIVE' } });
    return count <= 1;
  }
  return false;
}

// Deactivate a user — preserves all historical attribution, just blocks login.
router.post('/:userId/deactivate', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    // Nobody deactivates their own account through this admin action —
    // that's an irreversible-from-the-inside lockout (a deactivated user
    // can't log back in to undo it). Applies even to a Platform Owner,
    // who would otherwise always pass the seniority check below.
    if (target.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You cannot deactivate your own account.' });
    }
    // Same seniority rule as send-password-reset above — a manager must
    // never be able to lock out a peer or superior (e.g. their own owner).
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
    }
    // Never leave an agency with zero active owners, or the platform with
    // zero active platform owners — that locks everyone out of admin
    // recovery, not just the one account being deactivated.
    if (await isLastActiveOwner(target)) {
      return res.status(409).json({
        success: false,
        error: 'LAST_ACTIVE_OWNER',
        message: target.role === 'PLATFORM_OWNER'
          ? 'This is the only active Platform Owner — promote another account first.'
          : 'This is the only active owner for this agency — promote another manager to owner first.',
      });
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

// Permanently delete a deactivated user. Modeled on Factory Reset's own
// preview+confirm, ordered-transaction pattern (agencies.js). Every
// User-related table in this schema falls into one of three buckets:
//   - BLOCKING: a required FK on content other people/the agency still
//     depend on (a note they left on a lead, a call they uploaded, a
//     chat message, etc.) — if any exist, the purge is refused outright
//     rather than guessing whether to delete someone else's visible
//     history. The caller sees exactly what's blocking it.
//   - optional FK: nulled out, the referencing row (a Lead, a Task...)
//     stays intact — same precedent AuditEvent.actorId already uses
//     (it's deliberately nullable for exactly this reason).
//   - the user's own personal/login records: deleted outright.
// Three further references are NOT real Prisma relations at all (this
// schema has zero `onDelete` clauses anywhere, and these three have no
// `@relation` on the field) — Postgres won't block a user delete over
// them, but they'd silently orphan if not cleaned up here too:
// Notification.userId, FlowScoreSnapshot.subjectId, TelemarketerProfile.userId.
async function countPurgeBlockers(userId) {
  const [
    leadNotes, leadActivities, calls, messages, producerNotesAbout, producerNotesBy,
    telemarketerAssignments, transfersCreated, importBatchesUploaded, announcementsCreated,
    invitationsSent,
  ] = await Promise.all([
    prisma.leadNote.count({ where: { authorId: userId } }),
    prisma.leadActivity.count({ where: { createdById: userId } }),
    prisma.call.count({ where: { uploadedById: userId } }),
    prisma.message.count({ where: { authorId: userId } }),
    prisma.producerNote.count({ where: { producerId: userId } }),
    prisma.producerNote.count({ where: { authorId: userId } }),
    prisma.telemarketerAssignment.count({ where: { telemarketerId: userId } }),
    prisma.transfer.count({ where: { createdByTMId: userId } }),
    prisma.leadImportBatch.count({ where: { uploadedById: userId } }),
    prisma.announcement.count({ where: { createdById: userId } }),
    prisma.invitation.count({ where: { invitedById: userId } }),
  ]);
  return {
    leadNotes, leadActivities, calls, messages,
    producerNotesAbout, producerNotesBy, telemarketerAssignments,
    transfersCreated, importBatchesUploaded, announcementsCreated, invitationsSent,
  };
}

function blockerTotal(blockers) {
  return Object.values(blockers).reduce((sum, n) => sum + n, 0);
}

router.get('/:userId/purge-preview', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
    }
    if (target.status !== 'DEACTIVATED') {
      return res.status(400).json({ success: false, error: 'NOT_DEACTIVATED', message: 'Only a deactivated account can be permanently deleted. Deactivate it first.' });
    }
    const blockers = await countPurgeBlockers(target.id);
    return res.json({
      success: true,
      user: { id: target.id, email: target.email, firstName: target.firstName, lastName: target.lastName },
      blockers,
      canPurge: blockerTotal(blockers) === 0,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:userId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (target.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You cannot delete your own account.' });
    }
    if (!canActOnUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to manage this user.' });
    }
    if (target.status !== 'DEACTIVATED') {
      return res.status(400).json({ success: false, error: 'NOT_DEACTIVATED', message: 'Only a deactivated account can be permanently deleted. Deactivate it first.' });
    }
    if (req.body?.confirmText !== target.email) {
      return res.status(400).json({ success: false, error: 'CONFIRMATION_MISMATCH', message: "Type the user's exact email to confirm." });
    }
    // Never trust a stale preview — re-check right before the irreversible part.
    const blockers = await countPurgeBlockers(target.id);
    if (blockerTotal(blockers) > 0) {
      return res.status(409).json({
        success: false, error: 'HAS_RECORDED_HISTORY',
        message: 'This account has real recorded history and cannot be permanently deleted.',
        blockers,
      });
    }

    await prisma.$transaction(async (tx) => {
      // Sever optional FKs, preserving the referencing row.
      await Promise.all([
        tx.lead.updateMany({ where: { assignedToId: target.id }, data: { assignedToId: null } }),
        tx.lead.updateMany({ where: { createdById: target.id }, data: { createdById: null } }),
        tx.auditEvent.updateMany({ where: { actorId: target.id }, data: { actorId: null } }),
        tx.task.updateMany({ where: { assignedToId: target.id }, data: { assignedToId: null } }),
        tx.task.updateMany({ where: { createdById: target.id }, data: { createdById: null } }),
        tx.announcement.updateMany({ where: { targetUserId: target.id }, data: { targetUserId: null } }),
        tx.userBadge.updateMany({ where: { awardedById: target.id }, data: { awardedById: null } }),
        tx.ptoRequest.updateMany({ where: { reviewedById: target.id }, data: { reviewedById: null } }),
        tx.historicalRecord.updateMany({ where: { assignedToId: target.id }, data: { assignedToId: null } }),
        tx.leadImportBatch.updateMany({ where: { undoneById: target.id }, data: { undoneById: null } }),
        tx.leadProductQuote.updateMany({ where: { createdById: target.id }, data: { createdById: null } }),
        tx.transfer.updateMany({ where: { acceptedById: target.id }, data: { acceptedById: null } }),
      ]);

      // Delete the user's own personal/login rows outright — child rows
      // first where a real FK sits underneath (LessonCompletion before
      // TrainingAssignment; BreakRoomAchievement before GameSession
      // before TimeClockEntry).
      await tx.lessonCompletion.deleteMany({ where: { assignment: { userId: target.id } } });
      await tx.trainingAssignment.deleteMany({ where: { userId: target.id } });
      await tx.breakRoomAchievement.deleteMany({ where: { userId: target.id } });
      await tx.breakRoomGameSession.deleteMany({ where: { userId: target.id } });
      await tx.timeClockEntry.deleteMany({ where: { userId: target.id } });
      await Promise.all([
        tx.session.deleteMany({ where: { userId: target.id } }),
        tx.passwordResetToken.deleteMany({ where: { userId: target.id } }),
        tx.invitation.deleteMany({ where: { userId: target.id } }),
        tx.userBadge.deleteMany({ where: { userId: target.id } }),
        tx.ptoRequest.deleteMany({ where: { userId: target.id } }),
        tx.conversationParticipant.deleteMany({ where: { userId: target.id } }),
        tx.breakRoomHighScore.deleteMany({ where: { userId: target.id } }),
        tx.breakRoomJokeHistory.deleteMany({ where: { userId: target.id } }),
        tx.officeAlphaAssignment.deleteMany({ where: { userId: target.id } }),
        tx.notificationPreference.deleteMany({ where: { userId: target.id } }),
        tx.announcementAck.deleteMany({ where: { userId: target.id } }),
      ]);

      // Unenforced references (no real FK constraint, but would silently
      // orphan if left behind) — same subjectType/subjectId pattern
      // Factory Reset already uses for FlowScoreSnapshot.
      await Promise.all([
        tx.notification.deleteMany({ where: { userId: target.id } }),
        tx.flowScoreSnapshot.deleteMany({ where: { subjectType: 'USER', subjectId: target.id } }),
        tx.telemarketerProfile.deleteMany({ where: { userId: target.id } }),
      ]);

      await tx.user.delete({ where: { id: target.id } });
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: target.agencyId,
      action: 'user.purged',
      entityType: 'User',
      entityId: target.id,
      before: { email: target.email, firstName: target.firstName, lastName: target.lastName, role: target.role },
      correlationId: req.correlationId,
    });

    // No syncSeatCountForAgency call — the seat was already freed when
    // this account was deactivated.
    return res.json({ success: true });
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
module.exports.isLastActiveOwner = isLastActiveOwner;
