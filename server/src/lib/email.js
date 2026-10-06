// Email service adapter — Brevo transactional email API (plain fetch, no
// SDK). Uses Brevo's HTTPS API rather than SMTP: confirmed three separate
// times in this app's own history (Brevo-over-SMTP, then Gmail SMTP on
// port 465, then port 587) that raw SMTP egress is not viable from this
// host — every attempt failed with a connection-level error (timeout/
// ENETUNREACH/ESOCKET), while Brevo's HTTPS API is the one approach that
// has actually delivered in production. If BREVO_API_KEY is not
// configured, we do NOT pretend the email sent. We record it as
// NOT_CONFIGURED so the UI can show an honest state instead of a false
// success.

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
    // The accept link is logged even on a real send failure (not just the
    // NOT_CONFIGURED case above) — the one failure mode this app has hit
    // repeatedly in production, and previously left an operator with no
    // way to recover the link and relay it manually.
    console.error(`[email:FAILED] ${err.message} — Accept URL: ${acceptUrl}`);
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
    console.error(`[email:FAILED] ${err.message} — Reset URL: ${resetUrl}`);
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// rows come from lib/zipBreakdown.js's computeZipBreakdown() — zip is
// free-text intake data (bulk-uploaded or hand-entered), so it's escaped
// like any other user-controlled string before landing in an email sent to
// an external address.
async function sendZipReportEmail({ to, agencyName, rows }) {
  if (!isConfigured()) {
    console.warn(`[email:NOT_CONFIGURED] Would send zip code report for "${agencyName}" to ${to} (${rows.length} zips).`);
    return { status: 'NOT_CONFIGURED' };
  }
  try {
    const tableRows = rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.zip)}</td>
          <td>${r.totalLeads}</td>
          <td>${r.quotedCount}</td>
          <td>${r.soldCount}</td>
          <td>${r.cpa === null ? '—' : `$${r.cpa.toFixed(2)}`}</td>
          <td>${r.costPerLead === null ? '—' : `$${r.costPerLead.toFixed(2)}`}</td>
          <td>$${r.revenue.toFixed(2)}</td>
        </tr>`
      )
      .join('');
    const html = `
      <h2>${escapeHtml(agencyName)} — Zip Code Performance Report</h2>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
        <thead><tr>
          <th>Zip</th><th>Leads</th><th>Quoted</th><th>Sold</th><th>CPA</th><th>Cost/Lead</th><th>Revenue</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `;
    await sendEmail({ to, subject: `${agencyName} — Zip Code Performance Report`, html });
    return { status: 'SENT' };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED' };
  }
}

module.exports = { isConfigured, sendEmail, sendInvitationEmail, sendPasswordResetEmail, sendVendorPostingEmail, sendZipReportEmail };
