// Sends transactional notification emails via Resend's HTTP API.
// Failures here are logged but never thrown — a broken email should never break
// the actual RFI workflow (submitting, assigning, answering all still work).

// RESEND_API_KEY and FROM_ADDRESS are deliberately NOT read into constants here.
// They're read fresh inside sendEmail() every time it's called — reading them once
// at the top of this file would freeze whatever value existed at the exact moment
// the app started, and never notice if the .env file changes afterward (which is
// exactly the bug that caused emails to silently never send after adding the key
// post-deployment).
const FROM_ADDRESS_DEFAULT = 'onboarding@resend.dev';
const APP_NAME = 'The Lorel — RFI Log';

async function sendEmail({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || FROM_ADDRESS_DEFAULT;

  if (!RESEND_API_KEY) {
    console.log(`[email] Skipped — RESEND_API_KEY not set. Would have sent "${subject}" to ${to}`);
    return;
  }
  if (!to) {
    console.log(`[email] Skipped — no recipient email on file for "${subject}"`);
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${APP_NAME} <${FROM_ADDRESS}>`,
        to: [to],
        subject,
        html
      })
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[email] Resend API error (${response.status}) sending "${subject}" to ${to}:`, body);
    }
  } catch (err) {
    console.error(`[email] Failed to send "${subject}" to ${to}:`, err.message);
  }
}

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #16233A;">
      <p style="font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: #48566E; margin-bottom: 4px;">${APP_NAME}</p>
      ${bodyHtml}
      <p style="font-size: 12px; color: #48566E; margin-top: 24px;">This is an automated notification — please log in to the site to respond.</p>
    </div>
  `;
}

async function notifyNewRfiSubmitted({ ownerEmails, rfiNumber, subject }) {
  const html = wrapHtml(`
    <h2 style="font-size:16px;">New RFI needs your attention</h2>
    <p>RFI-${String(rfiNumber).padStart(3, '0')} was just submitted: <strong>${subject}</strong></p>
    <p>Log in to assign it to a consultant, or answer it yourself.</p>
  `);
  await Promise.all(ownerEmails.map(to => sendEmail({ to, subject: `New RFI-${String(rfiNumber).padStart(3, '0')} needs assignment`, html })));
}

async function notifyRfiAssigned({ consultantEmail, rfiNumber, subject }) {
  const html = wrapHtml(`
    <h2 style="font-size:16px;">A new RFI has been assigned to you</h2>
    <p>RFI-${String(rfiNumber).padStart(3, '0')}: <strong>${subject}</strong></p>
    <p>Log in to write your answer.</p>
  `);
  await sendEmail({ to: consultantEmail, subject: `RFI-${String(rfiNumber).padStart(3, '0')} assigned to you`, html });
}

async function notifyAnswerAwaitingApproval({ ownerEmails, rfiNumber, subject }) {
  const html = wrapHtml(`
    <h2 style="font-size:16px;">An answer is ready for your approval</h2>
    <p>RFI-${String(rfiNumber).padStart(3, '0')}: <strong>${subject}</strong></p>
    <p>Log in to review and publish it to the shared log.</p>
  `);
  await Promise.all(ownerEmails.map(to => sendEmail({ to, subject: `RFI-${String(rfiNumber).padStart(3, '0')} ready for approval`, html })));
}

module.exports = { notifyNewRfiSubmitted, notifyRfiAssigned, notifyAnswerAwaitingApproval };
