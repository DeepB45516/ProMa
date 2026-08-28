// lib/notifications.js
const crypto = require("crypto");
const { pool } = require("../db/pool");

const genId = () => crypto.randomUUID();

async function createNotification({ userId, title, message, link, teamId, activityId, type }) {
  if (!userId || !title || !message) return;
  try {
    const id = genId();
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, message, link, team_id, activity_id, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, title, message, link || null, teamId || null, activityId || null, type || "general"]
    );
  } catch (err) {
    console.warn("Failed to create notification:", err);
  }
}

module.exports = { createNotification };
