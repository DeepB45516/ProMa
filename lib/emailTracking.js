// lib/emailTracking.js — fire-and-forget email dispatch with delivery tracking.
//
// Task/team actions must never block their HTTP response on email delivery
// (SMTP/API calls can take seconds, especially on a cold connection). This
// helper kicks the send off in the background and records the outcome in
// `email_notifications` so failures are visible and retryable, without ever
// making the caller `await` the network call to the mail provider.
const crypto = require("crypto");
const { pool } = require("../db/pool");

const genId = () => crypto.randomUUID();

/**
 * Sends `sendFn()` in the background and records the result.
 * Returns immediately — callers should NOT await the email itself, only
 * (optionally) this function, which resolves as soon as any setup work is
 * done, before the email finishes sending.
 */
async function dispatchTrackedEmail({ userId, activityId, type, sendFn }) {
  // The `email_notifications` unique constraint is (user_id, activity_id,
  // notification_type). Postgres treats NULLs as distinct from each other,
  // so an ON CONFLICT upsert can't reconcile a "pending" row with a later
  // "sent" row when there's no activity_id (e.g. team-invite emails) — it
  // would just insert a second, orphaned row. In that case skip the
  // pre-write and record only the final outcome.
  if (activityId) {
    await recordEmailNotification({ userId, activityId, type, status: "pending" });
  }

  // Intentionally not awaited by the caller: run the actual provider call
  // in the background so task/team writes return to the browser instantly.
  sendFn()
    .then((result) =>
      recordEmailNotification({
        userId,
        activityId,
        type,
        status: result?.ok ? "sent" : "failed",
        providerMsgId: result?.id || null,
        errMsg: result?.ok ? null : result?.error || "Unknown email error",
      })
    )
    .catch((err) => {
      console.error(`[email] Background send failed (${type}):`, err.message);
      recordEmailNotification({
        userId,
        activityId,
        type,
        status: "failed",
        errMsg: err.message,
      }).catch(() => {});
    });
}

async function recordEmailNotification({ userId, activityId, type, status, providerMsgId, errMsg }) {
  if (!userId) return;
  try {
    if (activityId) {
      // Idempotent upsert keyed on (user, activity, type).
      await pool.query(
        `INSERT INTO email_notifications (id, user_id, activity_id, notification_type, status, provider_message_id, error_message, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'sent' THEN now() ELSE NULL END)
         ON CONFLICT (user_id, activity_id, notification_type) DO UPDATE
         SET status = EXCLUDED.status,
             provider_message_id = EXCLUDED.provider_message_id,
             error_message = EXCLUDED.error_message,
             sent_at = CASE WHEN EXCLUDED.status = 'sent' THEN now() ELSE email_notifications.sent_at END`,
        [genId(), userId, activityId, type, status, providerMsgId || null, errMsg || null]
      );
    } else {
      // No activity to key on (e.g. team invites) — just append a record
      // of this send attempt rather than trying to upsert against NULL.
      await pool.query(
        `INSERT INTO email_notifications (id, user_id, activity_id, notification_type, status, provider_message_id, error_message, sent_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)`,
        [genId(), userId, type, status, providerMsgId || null, errMsg || null]
      );
    }
  } catch (e) {
    console.warn("Failed to record email notification:", e.message);
  }
}

module.exports = { dispatchTrackedEmail, recordEmailNotification };
