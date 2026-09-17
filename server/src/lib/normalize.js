function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  return raw.trim().toLowerCase();
}

module.exports = { normalizePhone, normalizeEmail };
