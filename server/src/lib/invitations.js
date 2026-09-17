const crypto = require('crypto');

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

module.exports = { reissueInvitation };
