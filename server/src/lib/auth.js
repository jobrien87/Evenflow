const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma } = require('./db');

const SESSION_COOKIE = 'evenflow_session';
const SESSION_DAYS = 14;

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

async function createSession(userId, { userAgent, ipAddress } = {}) {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: { userId, tokenHash, userAgent, ipAddress, expiresAt },
  });
  return { rawToken, expiresAt };
}

async function getSessionUser(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt < new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;
  return session.user;
}

async function revokeSession(rawToken) {
  const tokenHash = hashToken(rawToken);
  await prisma.session.updateMany({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });
}

// Used on password reset — a stolen session shouldn't survive the account
// owner locking them out by changing the password.
async function revokeAllSessionsForUser(userId) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  revokeSession,
  revokeAllSessionsForUser,
  generateRawToken,
  hashToken,
};
