// lib/reminders.js — Scheduled Processing for Task Reminders & Overdue Notifications
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { sendTaskDueReminderEmail, sendTaskOverdueEmail } = require("./email");
const { createNotification } = require("./notifications");

const genId = () => crypto.randomUUID();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Core processing function for scheduled task reminders and overdue alerts.
 */
async function processTaskReminders() {
  const results = {
    processed: 0,
    remindersSent5h: 0,
    overdueSent: 0,
    errors: [],
  };

  try {
    // Select incomplete tasks with valid deadlines and assigned users
    const { rows: tasks } = await pool.query(
      `SELECT t.id, t.team_id, t.title, t.description, t.assignee_id, t.deadline, t.status,
              tm.name AS team_name,
              u.full_name AS assignee_name, u.email AS assignee_email,
              u.notif_email, u.notif_due_reminders, u.notif_overdue
       FROM tasks t
       JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = t.assignee_id
       WHERE t.status <> 'complete' AND t.assignee_id IS NOT NULL AND t.deadline IS NOT NULL`
    );

    for (const task of tasks) {
      results.processed++;
      const deadlineDate = new Date(task.deadline);
      const isOverdue = !isNaN(deadlineDate.getTime()) && deadlineDate.getTime() < Date.now();
      const isDueToday = !isNaN(deadlineDate.getTime()) && deadlineDate.toDateString() === new Date().toDateString();
      const deadlineStr = !isNaN(deadlineDate.getTime())
        ? deadlineDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
          (String(task.deadline).includes("T") || String(task.deadline).includes(":")
            ? ` at ${deadlineDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
            : "")
        : String(task.deadline);

      // 1. Process "Due Today" Reminder (Only one reminder sent per task
      //    per deadline — deadlines are date-only in this schema, so we
      //    can only truthfully say "today", not a precise hour count).
      if (isDueToday && !isOverdue) {
        const alreadySent = await hasEmailRecord(task.assignee_id, task.id, "due_today");
        if (!alreadySent) {
          let emailStatus = "skipped";
          let providerMsgId = null;
          let errMsg = null;

          if (task.notif_email !== false && task.notif_due_reminders !== false) {
            const emailRes = await sendTaskDueReminderEmail({
              to: task.assignee_email,
              recipientName: task.assignee_name,
              taskTitle: task.title,
              teamName: task.team_name,
              dueDate: deadlineStr,
              timeWindow: "today",
            });
            emailStatus = emailRes.ok ? "sent" : "failed";
            providerMsgId = emailRes.id || null;
            errMsg = emailRes.error || null;
            if (emailRes.ok) results.remindersSent5h++;
          }

          await recordEmailNotification({
            userId: task.assignee_id,
            activityId: task.id,
            type: "due_today",
            status: emailStatus === "sent" ? "sent" : emailStatus === "failed" ? "failed" : "pending",
            providerMsgId,
            errMsg,
          });

          // In-app notification
          await createNotification({
            userId: task.assignee_id,
            teamId: task.team_id,
            activityId: task.id,
            type: "due_today",
            title: "Activity Due Today",
            message: `"${task.title}" in team ${task.team_name} is due today (${deadlineStr}).`,
            link: `/teams/${task.team_id}/tasks`,
          });
        }
      }

      // 2. Process Overdue Notification
      if (isOverdue) {
        const alreadySent = await hasEmailRecord(task.assignee_id, task.id, "overdue");
        if (!alreadySent) {
          let emailStatus = "skipped";
          let providerMsgId = null;
          let errMsg = null;

          if (task.notif_email !== false && task.notif_overdue !== false) {
            const emailRes = await sendTaskOverdueEmail({
              to: task.assignee_email,
              recipientName: task.assignee_name,
              taskTitle: task.title,
              teamName: task.team_name,
              dueDate: deadlineStr,
            });
            emailStatus = emailRes.ok ? "sent" : "failed";
            providerMsgId = emailRes.id || null;
            errMsg = emailRes.error || null;
            if (emailRes.ok) results.overdueSent++;
          }

          await recordEmailNotification({
            userId: task.assignee_id,
            activityId: task.id,
            type: "overdue",
            status: emailStatus === "sent" ? "sent" : emailStatus === "failed" ? "failed" : "pending",
            providerMsgId,
            errMsg,
          });

          await createNotification({
            userId: task.assignee_id,
            teamId: task.team_id,
            activityId: task.id,
            type: "overdue",
            title: "Activity Overdue",
            message: `"${task.title}" in team ${task.team_name} is overdue (was due ${deadlineStr}).`,
            link: `/teams/${task.team_id}/tasks`,
          });
        }
      }
    }
  } catch (err) {
    console.error("Error in processTaskReminders:", err);
    results.errors.push(err.message);
  }

  return results;
}

async function hasEmailRecord(userId, activityId, notifType) {
  const { rows } = await pool.query(
    `SELECT 1 FROM email_notifications WHERE user_id = $1 AND activity_id = $2 AND notification_type = $3`,
    [userId, activityId, notifType]
  );
  return Boolean(rows[0]);
}

async function recordEmailNotification({ userId, activityId, type, status, providerMsgId, errMsg }) {
  try {
    await pool.query(
      `INSERT INTO email_notifications (id, user_id, activity_id, notification_type, status, provider_message_id, error_message, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'sent' THEN now() ELSE NULL END)
       ON CONFLICT (user_id, activity_id, notification_type) DO UPDATE
       SET status = EXCLUDED.status, provider_message_id = EXCLUDED.provider_message_id, error_message = EXCLUDED.error_message`,
      [genId(), userId, activityId, type, status, providerMsgId || null, errMsg || null]
    );
  } catch (e) {
    console.warn("Failed to record email notification:", e.message);
  }
}

module.exports = { processTaskReminders };
