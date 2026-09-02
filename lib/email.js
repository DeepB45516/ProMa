// lib/email.js — Email Integration for ProMa (Supports Brevo, Resend, and SMTP)
const nodemailer = require("nodemailer");
const dns = require("dns");
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const isProduction = process.env.NODE_ENV === "production";

function cleanEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : value;
}

function isTruthyEnv(name) {
  return String(cleanEnv(name) || "").toLowerCase() === "true";
}

function isRunningOnRender() {
  return isTruthyEnv("RENDER");
}

function isSmtpConfigured() {
  return Boolean(cleanEnv("SMTP_USER") && process.env.SMTP_PASS);
}

function canUseSmtpHere() {
  return isSmtpConfigured() && (!isRunningOnRender() || isTruthyEnv("ALLOW_SMTP_ON_RENDER"));
}

function hasEmailProvider() {
  return Boolean(
    isSmtpConfigured() ||
      cleanEnv("BREVO_API_KEY") ||
      cleanEnv("RESEND_API_KEY")
  );
}

/**
 * Creates nodemailer transporter if SMTP credentials are provided
 */
function getTransporter() {
  const smtpUser = cleanEnv("SMTP_USER");
  const smtpPass = process.env.SMTP_PASS;

  if (smtpUser && smtpPass) {
    const cleanUser = smtpUser;
    const cleanPass = smtpPass.replace(/\s+/g, "");

    // Explicitly use port 587 + STARTTLS + family:4 (IPv4 only)
    // This bypasses Render's IPv6 issue — Render allows port 587 outbound
    const host = cleanEnv("SMTP_HOST") || "smtp.gmail.com";
    const port = Number(cleanEnv("SMTP_PORT")) || 587;
    const secure = port === 465; // true only for port 465 SSL, false for 587 STARTTLS

    return nodemailer.createTransport({
      host,
      port,
      secure,
      family: 4,           // CRITICAL: Force IPv4 — prevents ENETUNREACH on Render IPv6
      auth: {
        user: cleanUser,
        pass: cleanPass,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return null;
}

/**
 * Dispatch helper. Local development tries SMTP first for convenience.
 * Production/Render tries HTTPS email APIs first because Render's free
 * web services block outbound SMTP ports.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: "Recipient email is required" };

  const providerConfigured = hasEmailProvider();
  const providerErrors = [];
  const useHttpApiFirst = isProduction || isRunningOnRender();
  const smtpUser = cleanEnv("SMTP_USER") || null;
  const brevoKey = cleanEnv("BREVO_API_KEY");
  const resendKey = cleanEnv("RESEND_API_KEY");
  const senderEmail = cleanEnv("SENDER_EMAIL") || smtpUser || "noreply@promaapp.com";
  const senderName = "ProMa";

  async function trySmtp() {
    if (!isSmtpConfigured()) return null;

    if (!canUseSmtpHere()) {
      providerErrors.push(
        "SMTP: skipped because this Render environment blocks outbound SMTP ports. Configure BREVO_API_KEY or RESEND_API_KEY for deployed email delivery."
      );
      return null;
    }

    try {
      const transporter = getTransporter();
      const info = await transporter.sendMail({
        from: `ProMa <${smtpUser}>`,
        to: Array.isArray(to) ? to.join(",") : to,
        subject,
        html,
        text,
      });
      console.log(`[Email Sent] via SMTP (ID: ${info.messageId})`);
      return { ok: true, id: info.messageId, provider: "smtp" };
    } catch (smtpErr) {
      providerErrors.push(`SMTP: ${smtpErr.message}`);
      console.warn(`[SMTP Failed] ${smtpErr.message} — trying HTTPS API fallback...`);
      return null;
    }
  }

  async function tryBrevo() {
    if (!brevoKey) return null;

    try {
      const recipient = Array.isArray(to) ? to.map(e => ({ email: e })) : [{ email: to }];
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": brevoKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: recipient,
          subject,
          htmlContent: html || `<p>${text}</p>`,
          textContent: text,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.message || data.error || `Brevo API error (status ${res.status})`;
        providerErrors.push(`Brevo: ${errMsg}`);
        console.error(`[Brevo API Error] ${errMsg}`, JSON.stringify(data));
      } else {
        console.log(`[Email Sent] via Brevo HTTPS API (MessageId: ${data.messageId})`);
        return { ok: true, id: data.messageId, provider: "brevo" };
      }
    } catch (err) {
      providerErrors.push(`Brevo: ${err.message}`);
      console.error(`[Brevo Error] ${err.message}`);
    }
    return null;
  }

  async function tryResend() {
    if (!resendKey) return null;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: `ProMa <${senderEmail}>`,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.message || data.error || `Resend API error (status ${res.status})`;
        providerErrors.push(`Resend: ${errMsg}`);
        console.error(`[Resend API Error] ${errMsg}`, JSON.stringify(data));
      } else {
        console.log(`[Email Sent] via Resend HTTPS API (ID: ${data.id})`);
        return { ok: true, id: data.id, provider: "resend" };
      }
    } catch (err) {
      providerErrors.push(`Resend: ${err.message}`);
      console.error(`[Resend Error] ${err.message}`);
    }
    return null;
  }

  const providerOrder = useHttpApiFirst
    ? [tryBrevo, tryResend, trySmtp]
    : [trySmtp, tryBrevo, tryResend];

  for (const tryProvider of providerOrder) {
    const result = await tryProvider();
    if (result?.ok) return result;
  }

  // 4. Dev fallback only when no provider is configured. If a provider is
  // configured but failed, surface that failure so delivery issues get fixed.
  const failureSummary = providerErrors.length
    ? providerErrors.join(" | ")
    : "No email provider is configured.";

  if (isProduction || providerConfigured) {
    console.error(`[Email Delivery Failed] ${failureSummary}`);
    return {
      ok: false,
      error: providerErrors.length
        ? "Email provider failed to deliver the message."
        : "Email provider is not configured.",
      providerErrors,
    };
  }

  console.log(
    `\n==== [Email Dev Fallback] ====\nTo: ${to}\nSubject: ${subject}\n${text ? `Body: ${text}` : ""}\n=============================\n`
  );
  return { ok: true, devMode: true, id: `dev_${Date.now()}`, warning: failureSummary };
}

/**
 * Base HTML Template wrapper for ProMa emails
 */
function emailLayout({ title, content, ctaText, ctaUrl }) {
  const ctaButton = ctaText && ctaUrl
    ? `
      <div style="margin-top: 28px; margin-bottom: 24px; text-align: center;">
        <a href="${ctaUrl}" style="background-color: #3454D1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          ${ctaText}
        </a>
      </div>
    `
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px 0; color: #1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 10px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    <!-- Header -->
    <tr>
      <td style="background-color: #0f172a; padding: 20px 28px; text-align: left;">
        <div style="display: flex; align-items: center;">
          <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">ProMa<span style="color: #3454D1;">.</span></span>
        </div>
      </td>
    </tr>
    <!-- Content Body -->
    <tr>
      <td style="padding: 32px 28px;">
        <h2 style="margin-top: 0; color: #0f172a; font-size: 20px; font-weight: 700; line-height: 1.3;">${title}</h2>
        ${content}
        ${ctaButton}
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 28px 0 20px 0;" />
        <p style="font-size: 12px; color: #64748b; margin: 0;">
          This email was sent by ProMa. If you did not request this notification, you can safely ignore this email.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// 1. Verification OTP Email
async function sendVerificationOtpEmail(to, otp) {
  const title = "Verify Your Email Address";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Welcome to ProMa! Please enter the following 6-digit verification code to complete your signup process:</p>
      <div style="background-color: #f1f5f9; border-radius: 8px; padding: 18px; text-align: center; margin: 20px 0; border: 1px dashed #cbd5e1;">
        <span style="font-size: 32px; font-weight: 700; font-family: monospace; letter-spacing: 6px; color: #3454D1;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #64748b;">This verification code will expire in 10 minutes. Please do not share this code with anyone.</p>
    `,
  });

  return sendEmail({
    to,
    subject: `${otp} is your ProMa verification code`,
    html,
    text: `Your ProMa verification code is: ${otp}. It will expire in 10 minutes.`,
  });
}

// 2. Team Invitation Email
// 2. Team Invitation Email
async function sendTeamInviteEmail({ to, teamName, invitedBy, invitedByUsername, inviteUrl }) {
  const inviterDisplay = invitedByUsername ? `${invitedBy} (@${invitedByUsername})` : (invitedBy || "A team member");
  const title = `You've been invited to join ${teamName}`;
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        <strong>${inviterDisplay}</strong> has invited you to join the team <strong>${teamName}</strong> on ProMa.
      </p>
      <p style="font-size: 14px; color: #475569; line-height: 1.5;">
        Collaborate on tasks, track progress live, and stay aligned with your team.
      </p>
    `,
    ctaText: "Accept Invitation & Join Team",
    ctaUrl: inviteUrl || APP_URL,
  });

  return sendEmail({
    to,
    subject: `${inviterDisplay} invited you to join ${teamName} on ProMa`,
    html,
    text: `${inviterDisplay} has invited you to join ${teamName} on ProMa. Open ProMa to join: ${inviteUrl || APP_URL}`,
  });
}

// 3. Task Assignment Email
async function sendTaskAssignmentEmail({ to, recipientName, taskTitle, taskDescription, teamName, assignedBy, assignedByUsername, dueDate, status, taskUrl }) {
  const assignerDisplay = assignedByUsername ? `${assignedBy} (@${assignedByUsername})` : (assignedBy || "A team member");
  const title = "You have been assigned a new activity";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${recipientName || "there"},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        <strong>${assignerDisplay}</strong> has assigned an activity to you on ProMa.
      </p>
      
      <div style="background-color: #f8fafc; border-left: 4px solid #3454D1; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">${taskTitle}</div>
        ${taskDescription ? `<div style="font-size: 14px; color: #475569; margin-bottom: 12px;">${taskDescription}</div>` : ""}
        <table role="presentation" width="100%" style="font-size: 13px; color: #64748b;">
          <tr>
            <td style="padding: 2px 0;"><strong>Team:</strong> ${teamName}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Due Date:</strong> ${dueDate || "No deadline"}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Status:</strong> ${status || "To Do"}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Assigned by:</strong> ${assignerDisplay}</td>
          </tr>
        </table>
      </div>
    `,
    ctaText: "Open Task",
    ctaUrl: taskUrl || APP_URL,
  });

  return sendEmail({
    to,
    subject: `New activity assigned by ${assignerDisplay}: ${taskTitle}`,
    html,
    text: `You have been assigned "${taskTitle}" in ${teamName} by ${assignerDisplay}. Due: ${dueDate || "N/A"}.`,
  });
}

// 4. Task Due Reminder Email (sent once, the day the deadline arrives)
async function sendTaskDueReminderEmail({ to, recipientName, taskTitle, teamName, dueDate, timeWindow, taskUrl }) {
  // Deadlines are stored as a date only (no time-of-day), so we can only
  // honestly say the activity is due "today" — not a precise hour count.
  const windowLabel = timeWindow === "today" ? "today" : "soon";
  const title = `Reminder: Activity due ${windowLabel}`;
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${recipientName || "there"},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        This is an automatic reminder that your assigned activity <strong>"${taskTitle}"</strong> in team <strong>${teamName}</strong> is due ${windowLabel}.
      </p>

      <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 15px; font-weight: 700; color: #92400e;">${taskTitle}</div>
        <div style="font-size: 13px; color: #b45309; margin-top: 4px;"><strong>Due Date:</strong> ${dueDate}</div>
      </div>
    `,
    ctaText: "View Activity",
    ctaUrl: taskUrl || APP_URL,
  });

  return sendEmail({
    to,
    subject: `Reminder: "${taskTitle}" is due ${windowLabel}`,
    html,
    text: `Reminder: "${taskTitle}" in team ${teamName} is due ${windowLabel} (${dueDate}).`,
  });
}

// 5. Task Overdue Notification Email
async function sendTaskOverdueEmail({ to, recipientName, taskTitle, teamName, dueDate, taskUrl }) {
  const title = "Overdue Activity Alert";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${recipientName || "there"},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        The activity <strong>"${taskTitle}"</strong> in team <strong>${teamName}</strong> passed its deadline and has been marked as overdue.
      </p>

      <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 15px; font-weight: 700; color: #991b1b;">${taskTitle}</div>
        <div style="font-size: 13px; color: #b91c1c; margin-top: 4px;"><strong>Was due:</strong> ${dueDate}</div>
      </div>
      <p style="font-size: 14px; color: #475569;">Please update the status or complete the activity as soon as possible.</p>
    `,
    ctaText: "Open Overdue Activity",
    ctaUrl: taskUrl || APP_URL,
  });

  return sendEmail({
    to,
    subject: `Overdue: "${taskTitle}" in ${teamName}`,
    html,
    text: `The activity "${taskTitle}" in team ${teamName} is overdue (was due ${dueDate}).`,
  });
}

// 6. Password Reset Email
async function sendPasswordResetEmail({ to, resetUrl }) {
  const title = "Reset Your Password";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        We received a request to reset the password for your ProMa account. Click the button below to choose a new password.
      </p>
      <p style="font-size: 13px; color: #64748b;">This link will expire in 1 hour. If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
    `,
    ctaText: "Reset Password",
    ctaUrl: resetUrl,
  });

  return sendEmail({
    to,
    subject: "Reset your ProMa password",
    html,
    text: `Reset your ProMa password: ${resetUrl} (expires in 1 hour). If you didn't request this, ignore this email.`,
  });
}

module.exports = {
  sendEmail,
  hasEmailProvider,
  sendVerificationOtpEmail,
  sendTeamInviteEmail,
  sendTaskAssignmentEmail,
  sendTaskDueReminderEmail,
  sendTaskOverdueEmail,
  sendPasswordResetEmail,
};
