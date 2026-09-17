// Transcription provider adapter. If TRANSCRIPTION_PROVIDER_API_KEY isn't
// set, this returns { available: false } rather than a fabricated transcript
// per spec's "no fake AI" rule. The call remains stored and its status stays
// retryable; it never silently disappears just because this integration
// isn't configured.
//
// Written against a generic REST transcription API shape
// (TRANSCRIPTION_PROVIDER_URL + Bearer key) so a real provider can be wired
// in by setting the URL/key, without changing the call pipeline that calls
// this module.

function isConfigured() {
  return !!(process.env.TRANSCRIPTION_PROVIDER_API_KEY && process.env.TRANSCRIPTION_PROVIDER_URL);
}

async function transcribe(audioBuffer, mimeType) {
  if (!isConfigured()) {
    return { available: false };
  }

  const resp = await fetch(process.env.TRANSCRIPTION_PROVIDER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TRANSCRIPTION_PROVIDER_API_KEY}`,
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: audioBuffer,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Transcription provider error: ${resp.status} ${text}`);
    err.providerStatus = resp.status;
    throw err;
  }

  const data = await resp.json();
  return {
    available: true,
    transcript: data.text || '',
    segments: data.segments || null,
    provider: process.env.TRANSCRIPTION_PROVIDER_NAME || 'generic',
  };
}

module.exports = { transcribe, isConfigured };
