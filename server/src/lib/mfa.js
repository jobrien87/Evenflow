// TOTP multi-factor authentication (RFC 6238) — generation/verification
// helpers shared by the enroll/confirm/disable routes and the login
// second-factor step. Uses otplib's functional API directly rather than
// wrapping it further; this file's only real job is picking consistent
// options (issuer name, clock-drift tolerance) and owning the backup-code
// format, which otplib has no opinion on.

const crypto = require('crypto');
const { generateSecret: otplibGenerateSecret, generateURI, generate, verify } = require('otplib');

const ISSUER = 'Evenflow';
// Allow one 30s step of drift either side of the server's clock — standard
// practice for TOTP, since the user's phone and this server are never
// perfectly in sync.
const EPOCH_TOLERANCE_SECONDS = 30;
const BACKUP_CODE_COUNT = 10;

function generateSecret() {
  return otplibGenerateSecret();
}

function buildOtpauthUri(email, secret) {
  return generateURI({ issuer: ISSUER, label: email, secret });
}

async function verifyTotpToken(secret, token) {
  if (!secret || !token) return false;
  const normalized = String(token).trim();
  if (!/^\d{6}$/.test(normalized)) return false;
  try {
    const result = await verify({ secret, token: normalized, epochTolerance: EPOCH_TOLERANCE_SECONDS });
    return !!result.valid;
  } catch {
    return false;
  }
}

// Only used by a diagnostic/manual-test path, never by a real verify call —
// kept for symmetry with verifyTotpToken and for tests that need a real,
// currently-valid code without reaching into otplib directly.
async function generateTotpToken(secret) {
  return generate({ secret });
}

// Plain, unhashed codes — returned to the caller exactly once at
// confirmation time. Never persisted in this form; hashBackupCode's output
// is what's stored.
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex');
}

// Returns the matching hash if `code` matches one of `hashedCodes`, else
// null — never mutates the array itself; the caller removes the matched
// hash from the user's stored list to consume it.
function matchBackupCode(hashedCodes, code) {
  if (!code || !Array.isArray(hashedCodes) || hashedCodes.length === 0) return null;
  const candidate = hashBackupCode(code);
  return hashedCodes.includes(candidate) ? candidate : null;
}

module.exports = {
  generateSecret,
  buildOtpauthUri,
  verifyTotpToken,
  generateTotpToken,
  generateBackupCodes,
  hashBackupCode,
  matchBackupCode,
};
