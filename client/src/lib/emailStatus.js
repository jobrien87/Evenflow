// Shared status-line text for admin invite/reset actions. The server never
// returns the raw activation/reset token in these responses (security
// hardening — a token only ever reaches the target's own inbox), so this
// is deliberately just a status message, never a link to copy/paste.
export function emailStatusMessage(prefix, emailStatus) {
  if (emailStatus === 'SENT') return `${prefix} Email sent.`;
  if (emailStatus === 'NOT_CONFIGURED') return `${prefix} Email delivery isn't configured yet — ask a platform operator to check the server logs for the link, or resend once email is set up.`;
  if (emailStatus === 'FAILED') return `${prefix} The email failed to send — try resending, or ask a platform operator to check the server logs.`;
  return `${prefix} Email status: ${emailStatus}`;
}

// Durable badge info for an invite/resend's most recent outcome, read
// straight off Invitation.lastEmailStatus/lastEmailSentAt (the persisted
// record behind the one-time emailStatusMessage() toast above). Returns
// null when nothing has been recorded yet (e.g. a user created before
// this tracking existed, or one never invited by email at all).
//
// This is deliberately just "did the Brevo API call succeed" — SENT
// means Brevo accepted the message, never that it reached an inbox. See
// lastEmailDeliveryInfo() below for the real, independently-confirmed
// outcome once Brevo's own delivery-event webhook reports one.
const STATUS_META = {
  SENT: { label: 'Email sent', tone: 'accent' },
  FAILED: { label: 'Email failed', tone: 'danger' },
  NOT_CONFIGURED: { label: 'Email not configured', tone: 'warning' },
};

export function lastEmailStatusInfo(invitation) {
  if (!invitation || !invitation.lastEmailStatus) return null;
  const meta = STATUS_META[invitation.lastEmailStatus] || { label: invitation.lastEmailStatus, tone: 'neutral' };
  const when = invitation.lastEmailSentAt ? new Date(invitation.lastEmailSentAt).toLocaleString() : '';
  return { ...meta, when, error: invitation.lastEmailStatus === 'FAILED' ? invitation.lastEmailError : null };
}

// The REAL delivery outcome, from a Brevo delivery-event webhook call
// (see server/src/lib/emailWebhook.js) — distinct from the API-accepted
// "Email sent" badge above. Returns null until a real webhook event
// arrives (no webhook configured, or Brevo hasn't reported one yet) —
// never fabricated as "delivered" just because the send call succeeded.
const DELIVERY_STATUS_META = {
  DELIVERED: { label: 'Delivered', tone: 'accent' },
  OPENED: { label: 'Opened', tone: 'accent' },
  CLICKED: { label: 'Clicked', tone: 'accent' },
  HARD_BOUNCE: { label: 'Bounced (invalid address)', tone: 'danger' },
  SOFT_BOUNCE: { label: 'Bounced (temporary)', tone: 'warning' },
  BLOCKED: { label: 'Blocked', tone: 'danger' },
  SPAM: { label: 'Marked as spam', tone: 'danger' },
  INVALID_EMAIL: { label: 'Invalid address', tone: 'danger' },
  DEFERRED: { label: 'Delivery deferred', tone: 'warning' },
  UNSUBSCRIBED: { label: 'Unsubscribed', tone: 'neutral' },
  ERROR: { label: 'Delivery error', tone: 'danger' },
};

export function lastEmailDeliveryInfo(invitation) {
  if (!invitation || !invitation.lastEmailDeliveryStatus) return null;
  const meta = DELIVERY_STATUS_META[invitation.lastEmailDeliveryStatus] || { label: invitation.lastEmailDeliveryStatus, tone: 'neutral' };
  const when = invitation.lastEmailDeliveryEventAt ? new Date(invitation.lastEmailDeliveryEventAt).toLocaleString() : '';
  return { ...meta, when };
}
