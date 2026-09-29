// Email service adapter — Gmail SMTP via nodemailer. GMAIL_USER is a real
// Gmail/Google Workspace address; GMAIL_APP_PASSWORD is a 16-character App
// Password generated for it (Google requires 2-Step Verification to be on
// before it will issue one — a normal account password will not
// authenticate over SMTP). If these are not configured, we do NOT pretend
// the email sent. We record it as NOT_CONFIGURED so the UI can show an
// honest state instead of a false success.

const nodemailer = require('nodemailer');

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'EvenFlow';

let cachedTransporter = null;
function getTransporter() {
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      // Port 465 (implicit TLS) connects but then times out from Render —
      // confirmed in production logs (a plain "Connection timeout" after the
      // IPv4 fix, not ENETUNREACH), the signature of a cloud egress network
      // silently dropping that specific port rather than a DNS/routing
      // problem. Port 587 with STARTTLS is Google's primary documented SMTP
      // port and far more commonly left open by cloud providers.
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      // Gmail's SMTP host resolves to both an IPv4 and an IPv6 address; on
      // hosts without outbound IPv6 routing (confirmed on Render — a real
      // production ENETUNREACH on the IPv6 address, not a credentials
      // problem), Node can pick the unreachable IPv6 address first. Forcing
      // IPv4 avoids that entirely.
      family: 4,
      // Nodemailer's defaults (2min connect / 10min socket) would leave an
      // API request hanging far too long if SMTP egress is ever blocked or
      // Gmail is slow to respond — fail fast into the honest FAILED status
      // instead.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });
  }
  return cachedTransporter;
}

function isConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function sendEmail({ to, subject, html }) {
  await getTransporter().sendMail({
    from: `"${EMAIL_FROM_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

async function sendInvitationEmail({ to, role, agencyName, token }) {
  const acceptUrl = `${APP_URL}/accept-invitation?token=${token}`;

  if (!isConfigured()) {
    console.warn(
      `[email:NOT_CONFIGURED] Would send invitation to ${to} (role=${role}, agency=${agencyName}). ` +
        `Set GMAIL_USER/GMAIL_APP_PASSWORD to enable real delivery. Accept URL: ${acceptUrl}`
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
    console.warn(`[email:NOT_CONFIGURED] Would send password reset to ${to}. Set GMAIL_USER/GMAIL_APP_PASSWORD to enable real delivery. Reset URL: ${resetUrl}`);
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
