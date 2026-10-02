// The ordered Coaching Video series shown at the top of the Coaching tab
// (intro -> mindset -> humor -> voice -> impression -> sp1 -> sp2). No new
// schema/table — this reads the agency's real Bunny Stream library live on
// every request and matches each video's own title to its fixed slot, so a
// newly-finished upload (e.g. sp2, still processing when this was built)
// appears automatically the next time anyone opens the tab, with zero
// manual sync step.

const bunnyStream = require('./bunnyStream');

const SLOTS = [
  { slug: 'INTRO', order: 1, label: 'Intro', synonyms: ['intro', 'introduction'] },
  { slug: 'MINDSET', order: 2, label: 'Mindset', synonyms: ['mindset'] },
  { slug: 'HUMOR', order: 3, label: 'Humor', synonyms: ['humor'] },
  { slug: 'VOICE', order: 4, label: 'Voice', synonyms: ['voice'] },
  { slug: 'IMPRESSION', order: 5, label: 'Impression', synonyms: ['impression'] },
  // The real library's current title is "SP0.01" (normalizes to "sp001")
  // — included alongside the plainer "sp1"/"sp101" spellings in case it's
  // ever renamed in Bunny to something closer to that.
  { slug: 'SP1', order: 6, label: 'SP1', synonyms: ['sp1', 'sp001', 'sp101', 'sp01'] },
  { slug: 'SP2', order: 7, label: 'SP2', synonyms: ['sp2', 'sp002', 'sp202', 'sp02'] },
];

function normalizeTitle(title) {
  return String(title || '')
    // Strip a real video-file extension only — a generic "last 2-4 chars
    // after a dot" rule would also eat the ".01" in a title like
    // "SP0.01", which is numbering, not a file extension.
    .replace(/\.(mp4|mov|mkv|avi|m4v|webm)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchLibraryVideos() {
  const res = await fetch(
    `https://video.bunnycdn.com/library/${process.env.BUNNY_STREAM_LIBRARY_ID}/videos?itemsPerPage=100`,
    { headers: { AccessKey: process.env.BUNNY_STREAM_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Bunny Stream error: ${res.status} ${text}`);
    err.providerStatus = res.status;
    throw err;
  }
  const data = await res.json();
  return data.items || [];
}

// Never fabricates a video that isn't really there — a slot with no
// matching title in the library comes back with bunnyVideoId/embedUrl
// null and available:false (the honest "still uploading" state), same
// as every other third-party-integration feature in this codebase.
async function listCoachingVideos() {
  if (!bunnyStream.isConfigured()) {
    return SLOTS.map((slot) => ({ slug: slot.slug, order: slot.order, label: slot.label, bunnyVideoId: null, embedUrl: null, durationSeconds: null, available: false }));
  }

  const libraryVideos = await fetchLibraryVideos();
  return SLOTS.map((slot) => {
    const match = libraryVideos.find((v) => slot.synonyms.includes(normalizeTitle(v.title)));
    return {
      slug: slot.slug,
      order: slot.order,
      label: slot.label,
      bunnyVideoId: match ? match.guid : null,
      embedUrl: match ? bunnyStream.embedUrl(match.guid) : null,
      durationSeconds: match ? match.length : null,
      available: !!match,
    };
  });
}

module.exports = { listCoachingVideos, normalizeTitle, SLOTS };
