const { test } = require('node:test');
const assert = require('node:assert/strict');
const bunnyStream = require('./bunnyStream');

function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

test('isConfigured: false when either env var is missing', () => withEnv(
  { BUNNY_STREAM_LIBRARY_ID: undefined, BUNNY_STREAM_API_KEY: undefined },
  () => assert.equal(bunnyStream.isConfigured(), false)
));

test('isConfigured: false with only the library id set', () => withEnv(
  { BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: undefined },
  () => assert.equal(bunnyStream.isConfigured(), false)
));

test('isConfigured: true once both are set', () => withEnv(
  { BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'key' },
  () => assert.equal(bunnyStream.isConfigured(), true)
));

test('embedUrl: builds the real Bunny iframe embed URL from the configured library id', () => withEnv(
  { BUNNY_STREAM_LIBRARY_ID: '768461', BUNNY_STREAM_API_KEY: 'key' },
  () => assert.equal(bunnyStream.embedUrl('abc-123'), 'https://iframe.mediadelivery.net/embed/768461/abc-123')
));

test('videoExists: throws NOT_CONFIGURED honestly rather than guessing when unset', () => withEnv(
  { BUNNY_STREAM_LIBRARY_ID: undefined, BUNNY_STREAM_API_KEY: undefined },
  async () => {
    await assert.rejects(() => bunnyStream.videoExists('abc-123'), (err) => err.code === 'NOT_CONFIGURED');
  }
));
