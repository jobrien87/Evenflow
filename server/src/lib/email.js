// Email service adapter.
// If RESEND_API_KEY (or another provider key) is not configured, we do NOT pretend
// the email sent. We record it as NOT_CONFIGURED so the UI can show an honest state
// (e.g. "INVITATION_FAILED / RESEND") instead of a false success.

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

async function sendInvitationEmail({ to, role, agencyName, token }) {
  const acceptUrl = `${APP_URL}/accept-invitation?token=${token}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn(
      `[email:NOT_CONFIGURED] Would send invitation to ${to} (role=${role}, agency=${agencyName}). ` +
        `Set RESEND_API_KEY to enable real delivery. Accept URL: ${acceptUrl}`
    );
    return { status: 'NOT_CONFIGURED', acceptUrl };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'EvenFlow <no-reply@evenflow.app>',
        to,
        subject: `You've been invited to EvenFlow`,
        html: `<p>You've been invited to join <strong>${agencyName}</strong> on EvenFlow as ${role}.</p>
               <p><a href="${acceptUrl}">Click here to activate your account</a></p>
               <p>This link expires in 7 days.</p>`,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[email:FAILED]', resp.status, text);
      return { status: 'FAILED', acceptUrl };
    }
    return { status: 'SENT', acceptUrl };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED', acceptUrl };
  }
}

async function sendVendorPostingEmail({ to, instructions }) {
  if (!process.env.RESEND_API_KEY) {
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
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'EvenFlow <no-reply@evenflow.app>',
        to,
        subject: `EvenFlow posting instructions — ${instructions.vendorName}`,
        html,
      }),
    });
    return { status: resp.ok ? 'SENT' : 'FAILED' };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED' };
  }
}

module.exports = { sendInvitationEmail, sendVendorPostingEmail };
