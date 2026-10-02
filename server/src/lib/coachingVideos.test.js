const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitle, SLOTS, listCoachingVideos } = require('./coachingVideos');

test('normalizeTitle: strips a file extension, lowercases, and removes punctuation', () => {
  assert.equal(normalizeTitle('Voice.mp4'), 'voice');
  assert.equal(normalizeTitle('Introduction'), 'introduction');
  assert.equal(normalizeTitle('SP0.01'), 'sp001');
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
});

test('SLOTS: the 7 real series slots, in the real intro->sp2 order, each with no duplicate order', () => {
  assert.deepEqual(SLOTS.map((s) => s.slug), ['INTRO', 'MINDSET', 'HUMOR', 'VOICE', 'IMPRESSION', 'SP1', 'SP2']);
  assert.deepEqual(SLOTS.map((s) => s.order), [1, 2, 3, 4, 5, 6, 7]);
});

test('SLOTS synonyms: the real current Bunny library titles each normalize into exactly one slot\'s synonym list', () => {
  const realTitles = ['Humor', 'Voice.mp4', 'Introduction', 'Impression', 'Mindset', 'SP0.01'];
  for (const title of realTitles) {
    const norm = normalizeTitle(title);
    const matches = SLOTS.filter((s) => s.synonyms.includes(norm));
    assert.equal(matches.length, 1, `"${title}" (normalized "${norm}") should match exactly one slot, matched: ${matches.map((m) => m.slug)}`);
  }
});

test('listCoachingVideos: honest unavailable state for every slot when Bunny is not configured', async () => {
  const original = { lib: process.env.BUNNY_STREAM_LIBRARY_ID, key: process.env.BUNNY_STREAM_API_KEY };
  delete process.env.BUNNY_STREAM_LIBRARY_ID;
  delete process.env.BUNNY_STREAM_API_KEY;
  try {
    const videos = await listCoachingVideos();
    assert.equal(videos.length, 7);
    for (const v of videos) {
      assert.equal(v.available, false);
      assert.equal(v.bunnyVideoId, null);
      assert.equal(v.embedUrl, null);
    }
  } finally {
    if (original.lib !== undefined) process.env.BUNNY_STREAM_LIBRARY_ID = original.lib;
    if (original.key !== undefined) process.env.BUNNY_STREAM_API_KEY = original.key;
  }
});
