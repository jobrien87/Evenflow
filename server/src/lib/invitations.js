const crypto = require('crypto');
const { prisma } = require('./db');

// Shared by every "resend invite" endpoint. Invitation.userId is @unique —
// each user has exactly one Invitation row for their whole lifetime, ever
// (created once, at invite time) — so "reissuing" means updating that same
// row with a fresh token and a new 7-day expiry, never creating a second
// one (that would violate the unique constraint). Must be called inside a
// prisma.$transaction.
async function reissueInvitation(tx, { userId, email, role, agencyId, invitedById }) {
  const rawToken = crypto.randomBytes(24).toString('hex');
  const existing = await tx.invitation.findUnique({ where: { userId } });
  if (existing) {
    await tx.invitation.update({
      where: { userId },
      data: {
        token: rawToken,
        invitedById,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
      },
    });
  } else {
    // Defensive fallback — shouldn't happen in practice, since every
    // invite flow creates the Invitation row in the same transaction as
    // the User, but don't hard-fail a resend if it's somehow missing.
    await tx.invitation.create({
      data: {
        email,
        role,
        token: rawToken,
        agencyId: agencyId || null,
        invitedById,
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  }
  return rawToken;
}

// Persists the outcome of a sendInvitationEmail()/sendPasswordResetEmail()-
// style call onto the real Invitation row, so it's visible later in the
// UI instead of only existing as the one-time response the caller saw at
// click time. Keyed by userId (Invitation.userId is unique), matching
// every invite/resend call site's own lookup — those always already know
// the target user's id. Best-effort: a tracking-write failure must never
// surface as if the invite/resend itself failed.
async function recordInvitationEmailResult(userId, emailResult) {
  try {
    await prisma.invitation.update({
      where: { userId },
      data: {
        lastEmailStatus: emailResult.status,
        lastEmailSentAt: new Date(),
        lastEmailError: emailResult.status === 'FAILED' ? (emailResult.error || null) : null,
      },
    });
  } catch (err) {
    console.error('[invitations] failed to record email result', err.message);
  }
}

module.exports = { reissueInvitation, recordInvitationEmailResult };
