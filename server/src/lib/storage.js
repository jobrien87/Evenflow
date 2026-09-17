// Storage adapter interface: save(buffer, key) -> storageKey, read(storageKey) -> buffer.
//
// This ships with a LOCAL DISK implementation for development and small-scale
// use. Per spec ("do not rely on ephemeral Render filesystem for critical
// uploads"), this is NOT production-durable on Render, the disk is wiped on
// every deploy/restart. Swapping to real object storage (S3, R2, GCS) means
// implementing these same two functions against that provider's SDK; nothing
// else in the call pipeline needs to change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), 'uploads');

function isObjectStorageConfigured() {
  return !!(process.env.OBJECT_STORAGE_BUCKET && process.env.OBJECT_STORAGE_KEY && process.env.OBJECT_STORAGE_SECRET);
}

async function save(buffer, originalFilename) {
  if (isObjectStorageConfigured()) {
    // Real object storage integration point. Not implemented in this build,
    // if these env vars are set without a real adapter behind them, fail
    // loudly rather than silently writing to local disk and pretending it
    // is durable.
    throw new Error(
      'OBJECT_STORAGE_* environment variables are set, but no real object storage adapter is implemented yet. ' +
        'Implement save()/read() in lib/storage.js against your chosen provider before relying on this in production.'
    );
  }

  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
  const ext = path.extname(originalFilename) || '';
  const safeKey = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, safeKey), buffer);
  return safeKey;
}

async function read(storageKey) {
  if (isObjectStorageConfigured()) {
    throw new Error('Real object storage read not implemented, see save() for the same note.');
  }
  return fs.readFileSync(path.join(UPLOAD_DIR, storageKey));
}

function storageHealth() {
  if (isObjectStorageConfigured()) {
    return { status: 'NOT_CONFIGURED', reason: 'Object storage env vars are set but no real adapter is implemented in this build.' };
  }
  return { status: 'LOCAL_DISK', reason: 'Using local disk storage, NOT durable on Render (ephemeral filesystem). Fine for development only.' };
}

module.exports = { save, read, storageHealth, isObjectStorageConfigured };
