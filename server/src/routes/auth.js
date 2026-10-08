const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { prisma } = require('../lib/db');
const { hashPassword, verifyPassword, createSession, revokeSession, revokeAllSessionsForUser, generateRawToken, hashToken, issuePasswordResetEmail, SESSION_COOKIE } = require('../lib/auth');
const { generateSecret, buildOtpauthUri, verifyTotpToken, generateBackupCodes, hashBackupCode, matchBackupCode } = require('../lib/mfa');
const { recordAudit } = require('../lib/audit');
const { syncSeatCountForAgency } = require('../lib/seatBilling');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' },
});

// Public, unauthenticated, token-guessing surface — the token itself is
// 192 bits of entropy (crypto.randomBytes(24) in lib/invitations.js) so
// brute force is infeasible, but a rate limit here is still cheap
// defense in depth against an unlimited-attempt public endpoint.
const acceptInvitationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

// Same reasoning as acceptInvitationLimiter — public, unauthenticated,
// and (for /forgot-password specifically) also a potential account-
// enumeration/spam vector against real inboxes, so a tighter window than
// login's.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

// Covers both halves of an MFA-protected login (the public /mfa/verify
// step) and the authenticated enroll-confirm/disable actions — a 6-digit
// TOTP code is a real brute-force surface even behind a login, so this
// gets its own modest budget rather than relying on loginLimiter alone.
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

// How long a password-verified login has to complete its second factor
// before the challenge token expires and the user must log in again.
const MFA_CHALLENGE_MINUTES = 5;

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

    // A failed-login audit trail is the one real signal for detecting a
    // credential-stuffing/brute-force pattern after the fact — recorded
    // for every failure reason, not just wrong-password, same real
    // forensic value regardless of which check rejected it.
    const auditFailedLogin = (reason) =>
      recordAudit({
        actorId: user?.id || null, actorRole: user?.role || null, agencyId: user?.agencyId || null,
        action: 'auth.login_failed', entityType: 'User', entityId: user?.id || null,
        metadata: { email, reason, ipAddress: req.ip, userAgent: req.headers['user-agent'] },
        correlationId: req.correlationId,
      });

    // Constant-shape response whether user exists or not, to avoid user enumeration.
    const genericFail = async (reason) => {
      await auditFailedLogin(reason);
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });
    };

    if (!user) return genericFail('no_such_user');
    if (user.status !== 'ACTIVE') {
      await auditFailedLogin('account_not_active');
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_NOT_ACTIVE',
        message: 'This account is not active. Contact your administrator.',
      });
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return genericFail('wrong_password');

    // Password confirmed, but a second factor is still required — not a
    // failure (never audited as one), and no session/cookie is issued
    // until the real code lands at POST /auth/mfa/verify.
    if (user.mfaEnabled) {
      const rawChallengeToken = generateRawToken();
      await prisma.mfaChallenge.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawChallengeToken),
          expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60 * 1000),
        },
      });
      return res.json({ success: true, mfaRequired: true, challengeToken: rawChallengeToken });
    }

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

const mfaVerifySchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().min(6).max(20),
});

// The second half of login for an mfaEnabled user — completes the session
// a password-only /login deliberately withheld. Accepts either a live TOTP
// code or an unused backup code; either way this is exactly as sensitive
// as a successful login and gets the same real session/cookie/audit
// treatment.
router.post('/mfa/verify', mfaLimiter, async (req, res, next) => {
  try {
    const parsed = mfaVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const challenge = await prisma.mfaChallenge.findUnique({
      where: { tokenHash: hashToken(parsed.data.challengeToken) },
      include: { user: true },
    });

    const genericMfaFail = async (reason, user) => {
      await recordAudit({
        actorId: user?.id || null, actorRole: user?.role || null, agencyId: user?.agencyId || null,
        action: 'auth.login_failed', entityType: 'User', entityId: user?.id || null,
        metadata: { reason, ipAddress: req.ip, userAgent: req.headers['user-agent'] },
        correlationId: req.correlationId,
      });
      return res.status(401).json({ success: false, error: 'INVALID_MFA_CODE', message: 'Invalid or expired code.' });
    };

    if (!challenge || challenge.usedAt || challenge.expiresAt < new Date()) {
      return genericMfaFail('mfa_challenge_invalid', challenge?.user);
    }
    const user = challenge.user;
    if (user.status !== 'ACTIVE' || !user.mfaEnabled) {
      return genericMfaFail('mfa_challenge_invalid', user);
    }

    let consumedBackupHash = null;
    let ok = await verifyTotpToken(user.mfaSecret, parsed.data.code);
    if (!ok) {
      consumedBackupHash = matchBackupCode(user.mfaBackupCodes, parsed.data.code);
      ok = !!consumedBackupHash;
    }
    if (!ok) return genericMfaFail('mfa_invalid_code', user);

    await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { usedAt: new Date() } });
    if (consumedBackupHash) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaBackupCodes: user.mfaBackupCodes.filter((h) => h !== consumedBackupHash) },
      });
    }

    const { rawToken, expiresAt } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
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
      metadata: { via: consumedBackupHash ? 'mfa_backup_code' : 'mfa_totp' },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, user: publicUser(user) });
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

// Starts (or restarts) TOTP enrollment — generates a fresh secret and
// stores it as "pending" (never mfaEnabled) until confirmed with a real
// code from the authenticator app below. Safe to call again before
// confirming: the previous pending secret is simply replaced.
router.post('/mfa/enroll', async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  try {
    const secret = generateSecret();
    await prisma.user.update({ where: { id: req.user.id }, data: { mfaPendingSecret: secret } });
    const otpauthUrl = buildOtpauthUri(req.user.email, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    return res.json({ success: true, secret, otpauthUrl, qrDataUrl });
  } catch (err) {
    next(err);
  }
});

const mfaConfirmSchema = z.object({ code: z.string().min(6).max(6) });

// Proves the user actually has the pending secret loaded in a real
// authenticator app before turning MFA on — never enabled on the enroll
// call alone. Returns the one-time plaintext backup codes; only their
// hashes are ever persisted.
router.post('/mfa/confirm', mfaLimiter, async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  try {
    const parsed = mfaConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const freshUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!freshUser.mfaPendingSecret) {
      return res.status(400).json({
        success: false, error: 'NO_PENDING_ENROLLMENT',
        message: 'Start enrollment again before confirming a code.',
      });
    }
    const ok = await verifyTotpToken(freshUser.mfaPendingSecret, parsed.data.code);
    if (!ok) {
      return res.status(400).json({
        success: false, error: 'INVALID_CODE',
        message: 'That code is incorrect or expired. Try the latest code from your authenticator app.',
      });
    }

    const backupCodes = generateBackupCodes();
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        mfaEnabled: true,
        mfaSecret: freshUser.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaBackupCodes: backupCodes.map(hashBackupCode),
        mfaEnrolledAt: new Date(),
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'mfa.enabled', entityType: 'User', entityId: req.user.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, user: publicUser(updated), backupCodes });
  } catch (err) {
    next(err);
  }
});

const mfaDisableSchema = z.object({ password: z.string().min(1), code: z.string().min(6).max(20) });

// Requires both the account password and a real second-factor code (TOTP
// or an unused backup code) — a stolen, still-logged-in session alone is
// never enough to turn MFA off.
router.post('/mfa/disable', mfaLimiter, async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  try {
    const parsed = mfaDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const freshUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!freshUser.mfaEnabled) {
      return res.status(400).json({ success: false, error: 'MFA_NOT_ENABLED' });
    }
    const passwordOk = await verifyPassword(parsed.data.password, freshUser.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Incorrect password.' });
    }
    let codeOk = await verifyTotpToken(freshUser.mfaSecret, parsed.data.code);
    if (!codeOk && matchBackupCode(freshUser.mfaBackupCodes, parsed.data.code)) codeOk = true;
    if (!codeOk) {
      return res.status(400).json({ success: false, error: 'INVALID_CODE', message: 'Incorrect verification code.' });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaBackupCodes: [], mfaEnrolledAt: null },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'mfa.disabled', entityType: 'User', entityId: req.user.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

// Marks the first-login product tour dismissed (finished or skipped) so it
// doesn't show again. Uses req.realUser (not req.user) so an impersonated
// session never writes to the target's own tour state.
router.post('/complete-tour', async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  try {
    const updated = await prisma.user.update({
      where: { id: req.realUser.id },
      data: { tourCompletedAt: new Date() },
    });
    return res.json({ success: true, user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

// Marks the one-time first-login celebration (lib/useAccountCelebrations.js)
// shown so it never fires again for this account. Same req.realUser
// pattern as /complete-tour, for the same reason.
router.post('/complete-first-login-celebration', async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  try {
    const updated = await prisma.user.update({
      where: { id: req.realUser.id },
      data: { firstLoginCelebratedAt: new Date() },
    });
    return res.json({ success: true, user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
});

router.post('/accept-invitation', acceptInvitationLimiter, async (req, res, next) => {
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

    if (result.agencyId) await syncSeatCountForAgency(result.agencyId);

    return res.json({ success: true, message: 'Account activated. You may now log in.' });
  } catch (err) {
    next(err);
  }
});

const forgotPasswordSchema = z.object({ email: z.string().email() });

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const email = parsed.data.email.trim().toLowerCase();

    // Always the same response whether the email matches a real, active
    // account or not — never let this endpoint confirm/deny account
    // existence to an unauthenticated caller.
    const genericResponse = { success: true, message: "If that email has an account, we've sent a reset link." };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') {
      return res.json(genericResponse);
    }

    const emailResult = await issuePasswordResetEmail(user);
    if (emailResult.status !== 'SENT') {
      console.warn(`[auth:forgot-password] email not sent (status=${emailResult.status}) for ${user.email}`);
    }

    return res.json(genericResponse);
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
});

router.post('/reset-password', resetPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const tokenHash = hashToken(parsed.data.token);
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!resetToken) {
      return res.status(404).json({ success: false, error: 'RESET_TOKEN_NOT_FOUND' });
    }
    if (resetToken.usedAt) {
      return res.status(409).json({ success: false, error: 'RESET_TOKEN_ALREADY_USED' });
    }
    if (resetToken.expiresAt < new Date()) {
      return res.status(410).json({ success: false, error: 'RESET_TOKEN_EXPIRED' });
    }

    const passwordHash = await hashPassword(parsed.data.password);

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: resetToken.userId }, data: { passwordHash } });
      await tx.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } });
      return updated;
    });

    // A password reset is exactly the moment a stolen/leaked session
    // should stop working, not just future logins.
    await revokeAllSessionsForUser(user.id);

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      agencyId: user.agencyId,
      action: 'user.password_reset',
      entityType: 'User',
      entityId: user.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, message: 'Password updated. You may now log in.' });
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
    tourCompletedAt: user.tourCompletedAt,
    // Personalize page — the storage key itself never leaves the server,
    // the client just needs to know whether to fetch GET /users/me/background.
    hasBackgroundImage: !!user.backgroundImageStorageKey,
    // Drives lib/useAccountCelebrations.js's one-time first-login and
    // yearly birthday celebration moments.
    birthday: user.birthday,
    firstLoginCelebratedAt: user.firstLoginCelebratedAt,
    mfaEnabled: user.mfaEnabled,
  };
}

module.exports = router;
