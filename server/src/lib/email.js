// Email service adapter — Brevo transactional email API (plain fetch, no
// SDK, same pattern this codebase already uses for Resend/Anthropic calls).
// If BREVO_API_KEY is not configured, we do NOT pretend the email sent. We
// record it as NOT_CONFIGURED so the UI can show an honest state instead of
// a false success.

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@yield-marketing.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'EvenFlow';

function isConfigured() {
  return !!process.env.BREVO_API_KEY;
}

async function sendEmail({ to, subject, html }) {
  const resp = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Brevo ${resp.status}: ${text}`);
  }
}

async function sendInvitationEmail({ to, role, agencyName, token }) {
  const acceptUrl = `${APP_URL}/accept-invitation?token=${token}`;

  if (!isConfigured()) {
    console.warn(
      `[email:NOT_CONFIGURED] Would send invitation to ${to} (role=${role}, agency=${agencyName}). ` +
        `Set BREVO_API_KEY to enable real delivery. Accept URL: ${acceptUrl}`
    );
    return { status: 'NOT_CONFIGURED', acceptUrl };
  }

  try {
    await sendEmail({
      to,
      subject: `You've been invited to EvenFlow`,
      html: `<p>You've been invited to join <strong>${agencyName}</strong> on EvenFlow as ${role}.</p>
             <p><a href="${acceptUrl}">Click here to activate your account</a></p>
             <p>This link expires in 7 days.</p>`,
    });
    return { status: 'SENT', acceptUrl };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED', acceptUrl };
  }
}

async function sendPasswordResetEmail({ to, token }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  if (!isConfigured()) {
    console.warn(`[email:NOT_CONFIGURED] Would send password reset to ${to}. Set BREVO_API_KEY to enable real delivery. Reset URL: ${resetUrl}`);
    return { status: 'NOT_CONFIGURED', resetUrl };
  }

  try {
    await sendEmail({
      to,
      subject: 'Reset your EvenFlow password',
      html: `<p>A password reset was requested for your EvenFlow account.</p>
             <p><a href="${resetUrl}">Click here to choose a new password</a></p>
             <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
    });
    return { status: 'SENT', resetUrl };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED', resetUrl };
  }
}

async function sendVendorPostingEmail({ to, instructions }) {
  if (!isConfigured()) {
    console.warn(`[email:NOT_CONFIGURED] Would send posting instructions to ${to} for vendor "${instructions.vendorName}". Endpoint: ${instructions.endpoint}`);
    return { status: 'NOT_CONFIGURED' };
  }
  try {
    const html = `
      <h2>EvenFlow Posting Instructions — ${instructions.vendorName}</h2>
      <p><strong>Endpoint:</strong> ${instructions.method} ${instructions.endpoint}</p>
      <p><strong>Authentication:</strong> ${instructions.authentication}</p>
      <pre>${instructions.curlExample}</pre>
      <p>Test procedure:</p>
      <ol>${instructions.testProcedure.map((s) => `<li>${s}</li>`).join('')}</ol>
    `;
    await sendEmail({ to, subject: `EvenFlow posting instructions — ${instructions.vendorName}`, html });
    return { status: 'SENT' };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED' };
  }
}

module.exports = { isConfigured, sendEmail, sendInvitationEmail, sendPasswordResetEmail, sendVendorPostingEmail };
