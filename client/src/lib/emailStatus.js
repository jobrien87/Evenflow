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
