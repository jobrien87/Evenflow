// Brevo transactional-email delivery-event webhook business logic — the
// piece that upgrades "SENT" (Brevo's API accepted the request) into a
// real, independently-confirmed delivery outcome, or an honest failure.
// Brevo's own documented event payload shape (one event object, or an
// array of them when batched): { event, email, "message-id", ts/ts_event/
// date, ... }. See https://developers.brevo.com/docs/transactional-webhooks.
//
// Every row this writes reflects a real event Brevo itself reported —
// nothing here infers or guesses a delivery outcome from absence of data.
const { prisma } = require('./db');

// Brevo's raw event names -> this app's own normalized vocabulary. Kept
// as a flat map (not a regex/heuristic) so an unrecognized future Brevo
// event name fails loud (falls through to null/unclassified) rather than
// being silently misclassified.
const EVENT_MAP = {
  request: 'REQUESTED', // Brevo accepted and queued the send — informational only, never overwrites a later real outcome
  delivered: 'DELIVERED',
  hard_bounce: 'HARD_BOUNCE',
  soft_bounce: 'SOFT_BOUNCE',
  blocked: 'BLOCKED',
  spam: 'SPAM',
  invalid_email: 'INVALID_EMAIL',
  deferred: 'DEFERRED',
  opened: 'OPENED',
  unique_opened: 'OPENED',
  click: 'CLICKED',
  unsubscribed: 'UNSUBSCRIBED',
  error: 'ERROR',
};

function classifyBrevoEvent(rawEvent) {
  return EVENT_MAP[rawEvent] || null;
}

// Brevo's "request" event is never treated as a real outcome for
// Invitation.lastEmailDeliveryStatus — the app already has an equivalent
// signal (lastEmailStatus:'SENT', set the moment the API call itself
// succeeded). Writing REQUESTED there would read as a delivery
// confirmation it is not.
const DELIVERY_STATUS_EVENTS = new Set([
  'DELIVERED', 'HARD_BOUNCE', 'SOFT_BOUNCE', 'BLOCKED', 'SPAM',
  'INVALID_EMAIL', 'DEFERRED', 'OPENED', 'CLICKED', 'UNSUBSCRIBED', 'ERROR',
]);

function extractMessageId(raw) {
  return raw['message-id'] || raw.messageId || raw.message_id || null;
}

function extractOccurredAt(raw) {
  if (raw.ts_event) return new Date(raw.ts_event * 1000);
  if (raw.ts) return new Date(raw.ts * 1000);
  if (raw.date) return new Date(raw.date);
  return new Date();
}

// Processes one already-authenticated batch of Brevo webhook events.
// Never throws on a single bad/unmatched event — one malformed event in a
// batch must not drop the rest. Returns a summary for the route's
// response/logging, not for any caller to branch logic on.
async function processBrevoWebhookEvents(rawEvents) {
  let logged = 0;
  let skippedNoMessageId = 0;
  let correlated = 0;
  let ignoredOutOfOrder = 0;

  for (const raw of rawEvents) {
    const messageId = extractMessageId(raw);
    const normalized = classifyBrevoEvent(raw.event);
    if (!messageId || !normalized) {
      skippedNoMessageId += 1;
      continue;
    }
    const occurredAt = extractOccurredAt(raw);

    // Idempotent on (messageId, event) — Brevo documents at-least-once
    // delivery, so a retried call must never duplicate this row or
    // re-run the Invitation correlation below a second time.
    let event;
    try {
      event = await prisma.emailDeliveryEvent.create({
        data: {
          messageId,
          event: normalized,
          rawEvent: raw.event,
          email: raw.email || '',
          occurredAt,
          rawPayload: raw,
        },
      });
    } catch (err) {
      if (err.code === 'P2002') continue; // already recorded, true no-op
      throw err;
    }
    logged += 1;

    if (!DELIVERY_STATUS_EVENTS.has(normalized)) continue;

    const invitation = await prisma.invitation.findFirst({ where: { lastEmailMessageId: messageId } });
    if (!invitation) continue;

    // Out-of-order guard: a late-arriving event timestamped earlier than
    // the status already on record must never regress it — matches this
    // app's existing out-of-order webhook discipline (highLevelAppointments.js).
    if (invitation.lastEmailDeliveryEventAt && occurredAt <= invitation.lastEmailDeliveryEventAt) {
      ignoredOutOfOrder += 1;
      continue;
    }

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { lastEmailDeliveryStatus: normalized, lastEmailDeliveryEventAt: occurredAt },
    });
    await prisma.emailDeliveryEvent.update({ where: { id: event.id }, data: { invitationId: invitation.id } });
    correlated += 1;
  }

  return { logged, skippedNoMessageId, correlated, ignoredOutOfOrder };
}

module.exports = { classifyBrevoEvent, extractMessageId, extractOccurredAt, processBrevoWebhookEvents, DELIVERY_STATUS_EVENTS };
