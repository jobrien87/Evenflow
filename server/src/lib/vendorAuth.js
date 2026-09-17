const crypto = require('crypto');

// Credentials look like: evf_live_<prefix>.<secret>
// The prefix is stored in plaintext (used for fast lookup); the secret is
// never stored — only its SHA-256 hash is. The raw secret is shown to the
// user exactly once, at generation time, matching the spec's requirement
// that credentials are "never exposed after creation except where
// intentionally shown once."

function generateCredential() {
  const prefix = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const rawKey = `evf_live_${prefix}.${secret}`;
  const secretHash = hashSecret(secret);
  return { prefix, secret, rawKey, secretHash };
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function parseApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const withoutLabel = rawKey.startsWith('evf_live_') ? rawKey.slice('evf_live_'.length) : rawKey;
  const [prefix, secret] = withoutLabel.split('.');
  if (!prefix || !secret) return null;
  return { prefix, secret };
}

module.exports = { generateCredential, hashSecret, parseApiKey };
