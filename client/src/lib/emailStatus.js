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
