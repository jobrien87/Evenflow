const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const { prisma } = require('../lib/db');
const { hashPassword, verifyPassword, createSession, revokeSession, SESSION_COOKIE } = require('../lib/auth');
const { recordAudit } = require('../lib/audit');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    // Constant-shape response whether user exists or not, to avoid user enumeration.
    const genericFail = () =>
      res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });

    if (!user) return genericFail();
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_NOT_ACTIVE',
        message: 'This account is not active. Contact your administrator.',
      });
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return genericFail();

    const { rawToken, expiresAt } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    // Client and server are separate origins in production (different Render
    // subdomains), so the cookie must be SameSite=None + Secure to survive
    // cross-site fetches. In local dev (same-site, http), Lax + non-secure works.
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      expires: expiresAt,
    });

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      agencyId: user.agencyId,
      action: 'user.login',
      entityType: 'User',
      entityId: user.id,
      correlationId: req.correlationId,
    });

    return res.json({
      success: true,
      user: publicUser(user),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (rawToken) await revokeSession(rawToken);
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(SESSION_COOKIE, { sameSite: isProd ? 'none' : 'lax', secure: isProd });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  return res.json({ success: true, user: publicUser(req.user) });
});

const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
});

router.post('/accept-invitation', async (req, res, next) => {
  try {
    const parsed = acceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const invitation = await prisma.invitation.findUnique({ where: { token: parsed.data.token } });
    if (!invitation) {
      return res.status(404).json({ success: false, error: 'INVITATION_NOT_FOUND' });
    }
    if (invitation.acceptedAt) {
      return res.status(409).json({ success: false, error: 'INVITATION_ALREADY_USED' });
    }
    if (invitation.expiresAt < new Date()) {
      return res.status(410).json({ success: false, error: 'INVITATION_EXPIRED' });
    }

    const passwordHash = await hashPassword(parsed.data.password);

    const result = await prisma.$transaction(async (tx) => {
      let user;
      if (invitation.userId) {
        user = await tx.user.update({
          where: { id: invitation.userId },
          data: { passwordHash, status: 'ACTIVE' },
        });
      } else {
        return null;
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      // An Agency is created with status INVITED (see POST /agencies) and
      // nothing else in this codebase ever advances it. The owner accepting
      // their invitation is the real-world moment the agency actually goes
      // live, so activate it here — Ed's Platform Owner context and other
      // agency-wide counts (e.g. "3/5 agencies active") depend on this
      // status being real, not left permanently INVITED.
      if (invitation.role === 'AGENCY_OWNER' && invitation.agencyId) {
        await tx.agency.update({
          where: { id: invitation.agencyId },
          data: { status: 'ACTIVE' },
        });
      }

      return user;
    });

    if (!result) {
      return res.status(400).json({ success: false, error: 'INVITATION_HAS_NO_USER' });
    }

    await recordAudit({
      actorId: result.id,
      actorRole: result.role,
      agencyId: result.agencyId,
      action: 'user.activated',
      entityType: 'User',
      entityId: result.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, message: 'Account activated. You may now log in.' });
  } catch (err) {
    next(err);
  }
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    agencyId: user.agencyId,
    status: user.status,
  };
}

module.exports = router;
