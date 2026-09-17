// Per spec: "Do not trust MIME type alone." This sniffs the actual file
// bytes for known audio/video container signatures rather than trusting
// whatever Content-Type the browser/client sent.

const MAX_BYTES = 500 * 1024 * 1024; // 500MB

function sniffAudioType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WAVE') {
    return 'audio/wav';
  }
  if (buffer.slice(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (['M4A ', 'mp42', 'isom', 'qt  '].includes(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (buffer.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';

  return null;
}

function validateAudioUpload(buffer) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, reason: 'File is empty.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { valid: false, reason: `File exceeds the ${MAX_BYTES / (1024 * 1024)}MB limit.` };
  }
  const detectedType = sniffAudioType(buffer);
  if (!detectedType) {
    return { valid: false, reason: 'File does not match a recognized audio/video format (checked actual file signature, not just the reported type).' };
  }
  return { valid: true, detectedType };
}

module.exports = { validateAudioUpload, sniffAudioType, MAX_BYTES };
