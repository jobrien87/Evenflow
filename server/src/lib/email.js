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
      // Reuse a small pool of authenticated SMTP connections instead of a
      // fresh handshake per email — fewer handshakes means fewer chances
      // for an unfamiliar-IP greeting delay or transient connect failure
      // to hit any single send, and bulk invites (invite-bulk loops one
      // send per row) stop paying a full connect+auth round trip each time.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      // Unchanged from the already-proven-working baseline — confirmed
      // production failures here were a silently-dropped port (fixed by
      // switching to 587) and an unroutable IPv6 address (fixed by
      // family: 4), not a slow-but-eventually-successful handshake, so
      // there's no evidence a longer timeout helps. Left short and
      // deliberately so a genuinely stuck connection fails fast into a
      // retry (below) rather than holding the invite request open.
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

// Errors nodemailer/SMTP tag as permanent — retrying them wastes the
// retry budget on something that will never succeed (bad credentials,
// a rejected envelope/recipient). Everything else (timeouts, transient
// connection resets, a slow/unfamiliar-IP greeting) is worth one retry.
// Every invite/reset route awaits this synchronously before responding
// to the HTTP request, so this is deliberately ONE retry, not several —
// worst case (both attempts time out) is ~17s, not a request left
// hanging for the better part of a minute.
const NON_RETRYABLE_CODES = new Set(['EAUTH', 'EENVELOPE']);
const MAX_SEND_ATTEMPTS = 2;
const RETRY_DELAY_MS = [1200];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmail({ to, subject, html }) {
  const mail = { from: `"${EMAIL_FROM_NAME}" <${process.env.GMAIL_USER}>`, to, subject, html };
  let lastErr;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await getTransporter().sendMail(mail);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = !NON_RETRYABLE_CODES.has(err.code);
      if (!retryable || attempt === MAX_SEND_ATTEMPTS) break;
      console.warn(`[email:RETRY] attempt ${attempt} failed (${err.code || err.message}), retrying…`);
      await sleep(RETRY_DELAY_MS[attempt - 1]);
    }
  }
  throw lastErr;
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
