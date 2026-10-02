// Per-call coaching video, hosted on the agency's own Bunny.net Stream
// library — videos are uploaded directly in the Bunny.net dashboard, never
// by this app; Evenflow only stores the video's GUID and plays it back via
// Bunny's own iframe embed. See .env.example for the two required vars.
//
// isConfigured() follows this codebase's established honest-degradation
// convention (lib/aiProvider.js, lib/stripe.js): a feature backed by an
// unconfigured third-party integration must say so plainly, never pretend.

function isConfigured() {
  return !!(process.env.BUNNY_STREAM_LIBRARY_ID && process.env.BUNNY_STREAM_API_KEY);
}

function embedUrl(videoId) {
  return `https://iframe.mediadelivery.net/embed/${process.env.BUNNY_STREAM_LIBRARY_ID}/${videoId}`;
}

// Confirms a pasted video GUID actually exists in the configured library
// before we save it — catches a typo'd id with a clear error instead of a
// silently broken embed later. Read-only Management API call; this app
// never lists, uploads, or deletes Bunny videos.
async function videoExists(videoId) {
  if (!isConfigured()) {
    const err = new Error('Bunny Stream is not configured.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(
    `https://video.bunnycdn.com/library/${process.env.BUNNY_STREAM_LIBRARY_ID}/videos/${encodeURIComponent(videoId)}`,
    { headers: { AccessKey: process.env.BUNNY_STREAM_API_KEY, accept: 'application/json' } }
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Bunny Stream error: ${res.status} ${text}`);
    err.providerStatus = res.status;
    throw err;
  }
  return true;
}

module.exports = { isConfigured, embedUrl, videoExists };
