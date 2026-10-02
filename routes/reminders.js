// routes/reminders.js — Endpoint for triggering scheduled due-date reminders
const express = require("express");
const { processTaskReminders } = require("../lib/reminders");

const router = express.Router();

// Trigger reminder check manually or via scheduled cron job.
//
// This endpoint fans out real emails to every user with a due/overdue
// task, so it must not be left open to the public internet. The in-process
// setInterval in server.js already runs this on its own schedule; this
// route exists only so an external scheduler can also trigger it (useful
// on hosts like Render's free tier where the process — and therefore the
// interval — can be asleep). Require CRON_SECRET in production so the
// route can't be discovered and hammered by anyone; only allow it to run
// unauthenticated in local development for convenience.
router.post("/process-reminders", async (req, res, next) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isProd = process.env.NODE_ENV === "production";

    if (isProd && !cronSecret) {
      console.error(
        "CRON_SECRET is not set in production — refusing to run /api/internal/process-reminders. Set CRON_SECRET in your environment and send it as the X-Cron-Secret header to use this endpoint."
      );
      return res.status(503).json({ error: "This endpoint is not configured. Set CRON_SECRET to enable it." });
    }

    if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized cron trigger." });
    }

    const summary = await processTaskReminders();
    res.json({ ok: true, summary });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
