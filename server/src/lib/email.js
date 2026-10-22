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

// Returns Brevo's own messageId (e.g. "<xxx@smtp-relay.mailin.fr>") from
// the send response — the correlation key a later Brevo delivery-event
// webhook (lib/emailWebhook.js) uses to find which specific send this
// was. Null if Brevo's response shape ever omits it (never fabricated).
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
  const body = await resp.json().catch(() => ({}));
  return { messageId: body.messageId || null };
}

async function sendInvitationEmail({ to, role, agencyName, token }) {
  const acceptUrl = `${APP_URL}/accept-invitation?token=${token}`;

  if (!isConfigured()) {
    // Deliberately never logs acceptUrl — it embeds a live, unexpired,
    // single-use token. Printing it to server console would hand anyone
    // with log access (not just the admin who triggered this) a working
    // credential before the real recipient uses it. Recovery path is to
    // configure BREVO_API_KEY and use the real resend-invite action, not
    // to recover this exact token from logs.
    console.warn(`[email:NOT_CONFIGURED] Invitation to ${to} (role=${role}, agency=${agencyName}) not sent — BREVO_API_KEY is not set. Use resend-invite once email delivery is configured.`);
    return { status: 'NOT_CONFIGURED', acceptUrl };
  }

  try {
    const { messageId } = await sendEmail({
      to,
      subject: `You've been invited to EvenFlow`,
      html: `<p>You've been invited to join <strong>${agencyName}</strong> on EvenFlow as ${role}.</p>
             <p><a href="${acceptUrl}">Click here to activate your account</a></p>
             <p>This link expires in 7 days.</p>`,
    });
    return { status: 'SENT', acceptUrl, messageId };
  } catch (err) {
    // Same reasoning as the NOT_CONFIGURED case above — never log the raw
    // link, even on a real send failure. An operator recovers by using
    // resend-invite again once delivery is working, which issues a fresh
    // token rather than reusing this one.
    console.error(`[email:FAILED] Invitation to ${to} failed to send (${err.message}). Use resend-invite to retry.`);
    return { status: 'FAILED', acceptUrl, error: err.message };
  }
}

async function sendPasswordResetEmail({ to, token }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  if (!isConfigured()) {
    // See sendInvitationEmail above — the raw token-bearing URL is
    // deliberately never logged.
    console.warn(`[email:NOT_CONFIGURED] Password reset for ${to} not sent — BREVO_API_KEY is not set. Ask the user to retry once email delivery is configured.`);
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
    console.error(`[email:FAILED] Password reset for ${to} failed to send (${err.message}). Ask the user to retry.`);
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

// report comes from lib/vendorReport.js's computeVendorReport() — stats
// (real aggregate rates, same formulas as sendZipReportEmail) plus a
// full per-lead disposition table. Customer names/zips are free-text
// intake data, escaped like zip is above before landing in an email sent
// to an external (vendor) address.
async function sendVendorReportEmail({ to, agencyName, period, report }) {
  if (!isConfigured()) {
    console.warn(`[email:NOT_CONFIGURED] Would send vendor report for "${report.vendor.name}" to ${to} (${report.dispositions.length} leads).`);
    return { status: 'NOT_CONFIGURED' };
  }
  try {
    const { stats, dispositions, vendor } = report;
    const statsHtml = `
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin-bottom:20px;">
        <tbody>
          <tr><td><strong>Total Leads</strong></td><td>${stats.totalLeads}</td></tr>
          <tr><td><strong>Quoted</strong></td><td>${stats.quotedCount} (${stats.quoteRate === null ? '—' : `${stats.quoteRate}%`})</td></tr>
          <tr><td><strong>Sold</strong></td><td>${stats.soldCount} (${stats.closeRate === null ? '—' : `${stats.closeRate}%`})</td></tr>
          <tr><td><strong>Cost Per Lead</strong></td><td>${stats.costPerLead === null ? '—' : `$${stats.costPerLead.toFixed(2)}`}</td></tr>
          <tr><td><strong>CPA</strong></td><td>${stats.cpa === null ? '—' : `$${stats.cpa.toFixed(2)}`}</td></tr>
          <tr><td><strong>Revenue</strong></td><td>$${stats.revenue.toFixed(2)}</td></tr>
        </tbody>
      </table>
    `;
    const dispositionRows = dispositions
      .map(
        (d) => `<tr>
          <td>${escapeHtml(d.customerName)}</td>
          <td>${new Date(d.receivedAt).toLocaleDateString()}</td>
          <td>${escapeHtml(d.status)}</td>
          <td>${escapeHtml(d.product)}</td>
          <td>${escapeHtml(d.zip)}, ${escapeHtml(d.state)}</td>
          <td>${escapeHtml(d.assignedTo)}</td>
        </tr>`
      )
      .join('');
    const html = `
      <h2>${escapeHtml(agencyName)} — ${escapeHtml(vendor.vendorBrand || vendor.name)} Vendor Report</h2>
      <p>${new Date(period.from).toLocaleDateString()} – ${new Date(period.to).toLocaleDateString()}</p>
      ${statsHtml}
      <h3>Lead Disposition Detail</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
        <thead><tr>
          <th>Customer</th><th>Received</th><th>Disposition</th><th>Product</th><th>Location</th><th>Assigned To</th>
        </tr></thead>
        <tbody>${dispositionRows || '<tr><td colspan="6">No leads in this period.</td></tr>'}</tbody>
      </table>
    `;
    await sendEmail({ to, subject: `${agencyName} — ${vendor.vendorBrand || vendor.name} Vendor Report`, html });
    return { status: 'SENT' };
  } catch (err) {
    console.error('[email:FAILED]', err.message);
    return { status: 'FAILED' };
  }
}

module.exports = { isConfigured, sendEmail, sendInvitationEmail, sendPasswordResetEmail, sendVendorPostingEmail, sendZipReportEmail, sendVendorReportEmail };
