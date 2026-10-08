// Real-DB, real-HTTP tests for the call-recording PII lifecycle: a raw
// transcript is never stored (only a redacted one, transiently), and the
// recording + transcript are both permanently deleted ("burned") the
// moment scoring completes — see jobs/callProcessing.js's runAnalysis()
// and lib/transcriptRedaction.js. Matches this app's established real-DB/
// real-HTTP convention (see leadBulkImportDistribution.test.js,
// callScoringProfile.test.js) rather than mocking Prisma or the storage
// layer for logic that genuinely touches both.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const { read } = require('../lib/storage');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, ownerCookie, producerCookie, server, port, baseUrl;
const callIds = [];

const VALID_ANALYSIS = {
  summary: 'Producer discussed auto coverage, customer had budget concerns.',
  products_discussed: ['Auto'],
  objections: [{ objection: 'Price too high', handled_well: true, note: 'Offered a payment plan.' }],
  buying_signals: ['Asked about start date'],
  missed_opportunities: [],
  cross_sell_opportunities: [],
  follow_up_commitments: [],
  next_steps: ['Send written quote'],
  strengths: ['Clear explanation of coverage'],
  coaching_opportunities: ['Ask more discovery questions early'],
  overall_score: 78,
  dimension_scores: { Opening: 80, Rapport: 75, Discovery: 70, 'Needs Analysis': 72, 'Question Quality': 74, 'Product Positioning': 80, 'Value Communication': 78, 'Objection Handling': 82, Closing: 76, 'Next-Step Clarity': 79, 'Cross-Sell Awareness': 60, Professionalism: 90 },
  review_recommended: false,
};

// Only intercepts the outbound Anthropic call — everything else (our own
// test driver's fetch() calls to the local test server) passes straight
// through to the real fetch, since both share the same global.fetch.
function mockAnalysisFetchOnce(t) {
  const realFetch = global.fetch;
  t.mock.method(global, 'fetch', async (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://api.anthropic.com/')) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID_ANALYSIS) }], usage: { input_tokens: 500, output_tokens: 300 } }),
      };
    }
    return realFetch(url, ...rest);
  });
}

async function waitForStatus(callId, targetStatuses, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (targetStatuses.includes(call.status)) return call;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for call ${callId} to reach [${targetStatuses.join(', ')}], stuck at ${call.status}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function wavBlob() {
  const header = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  const body = Buffer.from('fake-audio-payload-for-testing-only');
  return new Blob([Buffer.concat([header, body])], { type: 'audio/wav' });
}

async function uploadCall(cookie = producerCookie) {
  const form = new FormData();
  form.append('recording', wavBlob(), 'test-call.wav');
  const res = await fetch(`${baseUrl}/api/calls`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  callIds.push(body.call.id);
  return body.call;
}

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Call Burn Test Agency ${suffix}`, coachingEnabled: true } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `call-burn-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Burn', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;

  const producer = await prisma.user.create({
    data: { email: `call-burn-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Burn', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  producerCookie = `evenflow_session=${(await createSession(producerId)).rawToken}`;

  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Burn anything the tests themselves didn't already burn, so a failed/
  // skipped assertion never leaves a stray file behind on disk.
  const remaining = await prisma.call.findMany({ where: { id: { in: callIds } }, select: { storageKey: true } });
  const { remove } = require('../lib/storage');
  await Promise.all(remaining.map((c) => c.storageKey && remove(c.storageKey).catch(() => {})));

  await prisma.callAnalysis.deleteMany({ where: { callId: { in: callIds } } });
  await prisma.call.deleteMany({ where: { id: { in: callIds } } });
  await prisma.aiUsageLog.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, producerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('uploading a recording stores a real file on disk; the API never exposes the raw storage key', async () => {
  const call = await uploadCall();
  assert.equal(call.recordingAvailable, true);
  assert.equal('storageKey' in call, false);

  const dbCall = await prisma.call.findUnique({ where: { id: call.id } });
  assert.ok(dbCall.storageKey);
  const bytes = await read(dbCall.storageKey); // throws if the file isn't really there
  assert.ok(bytes.length > 0);

  const audioRes = await fetch(`${baseUrl}/api/calls/${call.id}/audio`, { headers: { Cookie: producerCookie } });
  assert.equal(audioRes.status, 200);
});

test('manually entering a transcript with PII stores only the redacted version, never the raw one', async (t) => {
  const call = await uploadCall();
  const rawTranscript = 'Customer SSN is 123-45-6789, call back at 555-123-4567 or jane@example.com.';

  // Mocked so the PATCH's own fire-and-forget enqueueAnalysis() never makes
  // a real outbound call; waited out below so the mock stays live for its
  // entire (async) lifetime rather than being torn down mid-flight.
  mockAnalysisFetchOnce(t);

  const res = await fetch(`${baseUrl}/api/calls/${call.id}/transcript`, {
    method: 'PATCH',
    headers: { Cookie: producerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: rawTranscript }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.call.transcript.includes('[REDACTED-SSN]'));
  assert.ok(body.call.transcript.includes('[REDACTED-PHONE]'));
  assert.ok(body.call.transcript.includes('[REDACTED-EMAIL]'));
  assert.ok(!body.call.transcript.includes('123-45-6789'));

  const dbCall = await prisma.call.findUnique({ where: { id: call.id } });
  assert.ok(!dbCall.transcript.includes('123-45-6789'), 'the raw SSN must never be persisted, not even transiently');

  await waitForStatus(call.id, ['COMPLETE', 'FAILED']);
});

test('scoring completion burns the recording and discards the transcript — verified against the real filesystem, not just the DB flag', async (t) => {
  const call = await uploadCall();
  const dbCallBefore = await prisma.call.findUnique({ where: { id: call.id } });
  const originalStorageKey = dbCallBefore.storageKey;

  mockAnalysisFetchOnce(t);
  const patchRes = await fetch(`${baseUrl}/api/calls/${call.id}/transcript`, {
    method: 'PATCH',
    headers: { Cookie: producerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'producer: hello, thanks for calling about your auto policy.' }),
  });
  assert.equal(patchRes.status, 200);

  const completed = await waitForStatus(call.id, ['COMPLETE', 'FAILED']);
  assert.equal(completed.status, 'COMPLETE', completed.failureReason || '');
  assert.equal(completed.transcript, null);
  assert.equal(completed.storageKey, null);
  assert.ok(completed.recordingDeletedAt);
  assert.ok(completed.transcriptDiscardedAt);

  // The real file is actually gone from disk, not just unlinked in the DB.
  await assert.rejects(() => read(originalStorageKey));

  const apiRes = await fetch(`${baseUrl}/api/calls/${call.id}`, { headers: { Cookie: producerCookie } });
  const apiBody = await apiRes.json();
  assert.equal(apiBody.call.recordingAvailable, false);
  assert.equal(apiBody.call.transcript, null);
  assert.ok(apiBody.call.analysis, 'the structured CallAnalysis row is the permanent record from here on');

  // Burned audio: an honest 410, never a broken/empty audio response.
  const audioRes = await fetch(`${baseUrl}/api/calls/${call.id}/audio`, { headers: { Cookie: producerCookie } });
  assert.equal(audioRes.status, 410);
  const audioBody = await audioRes.json();
  assert.equal(audioBody.error, 'RECORDING_DELETED');

  // A scored call can't have its transcript re-entered.
  const reenterRes = await fetch(`${baseUrl}/api/calls/${call.id}/transcript`, {
    method: 'PATCH',
    headers: { Cookie: producerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'anything' }),
  });
  assert.equal(reenterRes.status, 409);
  const reenterBody = await reenterRes.json();
  assert.equal(reenterBody.error, 'ALREADY_SCORED');
});

test('a call that fails before a transcript exists keeps its recording intact for retry', async () => {
  // No transcription provider is configured in this test environment, so
  // the automatic pipeline (enqueued on upload) fails at the
  // transcription step — before any transcript exists, the recording
  // must still be there for a retry or a manual transcript entry.
  const call = await uploadCall();
  const failed = await waitForStatus(call.id, ['FAILED']);
  assert.ok(failed.failureReason);
  assert.equal(failed.transcript, null);
  assert.ok(failed.storageKey, 'recording must survive a transcription failure');

  const bytes = await read(failed.storageKey);
  assert.ok(bytes.length > 0);
});

test('a call that fails at the analysis stage keeps both its transcript and recording for retry', async () => {
  const call = await uploadCall();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; // forces analyzeTranscript's honest available:false path
  try {
    const patchRes = await fetch(`${baseUrl}/api/calls/${call.id}/transcript`, {
      method: 'PATCH',
      headers: { Cookie: producerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'producer: hi there, calling about your renewal.' }),
    });
    assert.equal(patchRes.status, 200);

    const failed = await waitForStatus(call.id, ['FAILED']);
    assert.ok(failed.failureReason.includes('not configured'));
    assert.ok(failed.transcript, 'transcript must be preserved so a retry does not require re-recording');
    assert.ok(failed.storageKey, 'recording is not burned until scoring actually succeeds');

    const bytes = await read(failed.storageKey);
    assert.ok(bytes.length > 0);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});
