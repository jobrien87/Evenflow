const { prisma } = require('../lib/db');
const { parseApiKey, hashSecret } = require('../lib/vendorAuth');

async function requireVendorAuth(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  const parsed = parseApiKey(rawKey);
  if (!parsed) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing or malformed X-Api-Key header.' });
  }

  const credential = await prisma.vendorCredential.findUnique({
    where: { keyPrefix: parsed.prefix },
    include: { vendor: true },
  });

  if (!credential || credential.status !== 'ACTIVE') {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or revoked API key.' });
  }
  if (hashSecret(parsed.secret) !== credential.secretHash) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid API key.' });
  }
  if (credential.vendor.status === 'PAUSED') {
    return res.status(403).json({ success: false, error: 'VENDOR_PAUSED', message: 'This vendor connection is currently paused.' });
  }

  req.vendor = credential.vendor;
  req.vendorCredential = credential;

  prisma.vendorCredential.update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  next();
}

module.exports = { requireVendorAuth };
