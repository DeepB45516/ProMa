// routes/users.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db/pool");
const { requireAuth, invalidateUserCache } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");

const router = express.Router();
router.use(requireAuth);

// Search users by email or username (for "add member" flows).
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, full_name, username, email, avatar_url
       FROM users WHERE LOWER(email) LIKE $1 OR LOWER(username) LIKE $1
       LIMIT 8`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.put("/me", async (req, res, next) => {
  try {
    const { fullName, username, bio, designation, mobile, avatarUrl } = req.body;
    const fields = [];
    const values = [];
    let i = 1;

    if (fullName !== undefined) { fields.push(`full_name = $${i++}`); values.push(fullName.trim()); }
    if (bio !== undefined) { fields.push(`bio = $${i++}`); values.push(bio.trim()); }
    if (designation !== undefined) { fields.push(`designation = $${i++}`); values.push(designation.trim()); }
    if (avatarUrl !== undefined) { fields.push(`avatar_url = $${i++}`); values.push(avatarUrl.trim() || null); }
    if (mobile !== undefined) { fields.push(`mobile = $${i++}`); values.push(mobile.trim() || null); }

    if (username !== undefined) {
      if (!username || !username.trim()) {
        return res.status(400).json({ error: "Username is required and cannot be empty." });
      }
      const clean = username.trim().toLowerCase();
      if (clean.length < 3) {
        return res.status(400).json({ error: "Username must be at least 3 characters long." });
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(clean)) {
        return res.status(400).json({ error: "Username can only contain letters, numbers, dots, underscores, and dashes." });
      }
      const taken = await pool.query(`SELECT 1 FROM users WHERE LOWER(username) = $1 AND id <> $2`, [clean, req.user.id]);
      if (taken.rows[0]) return res.status(409).json({ error: "That username is already taken. Please choose another username." });
      fields.push(`username = $${i++}`);
      values.push(clean);
    }

    if (fields.length === 0) return res.json({ user: req.user });

    values.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${i} RETURNING
        id, full_name, username, email, mobile, avatar_url, bio, designation,
        notif_email, notif_overdue, notif_assignment, notif_due_reminders, notif_team_invites,
        color_theme, created_at`,
      values
    );
    invalidateUserCache(req.user.id);
    res.json({ user: rows[0] });
  } catch (e) {
    next(e);
  }
});

router.put("/me/password", async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    const hasPassword = Boolean(rows[0]?.password_hash);

    if (hasPassword) {
      const ok = await bcrypt.compare(currentPassword || "", rows[0].password_hash);
      if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, req.user.id]);
    res.json({ ok: true, message: "Password updated." });
  } catch (e) {
    next(e);
  }
});

router.put("/me/notifications", async (req, res, next) => {
  try {
    const { notifEmail, notifOverdue, notifAssignment, notifDueReminders, notifTeamInvites } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
         notif_email = COALESCE($1, notif_email),
         notif_overdue = COALESCE($2, notif_overdue),
         notif_assignment = COALESCE($3, notif_assignment),
         notif_due_reminders = COALESCE($4, notif_due_reminders),
         notif_team_invites = COALESCE($5, notif_team_invites)
       WHERE id = $6 RETURNING notif_email, notif_overdue, notif_assignment, notif_due_reminders, notif_team_invites`,
      [notifEmail, notifOverdue, notifAssignment, notifDueReminders, notifTeamInvites, req.user.id]
    );
    invalidateUserCache(req.user.id);
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

const VALID_COLOR_THEMES = ["proma-blue", "ocean", "emerald", "violet", "slate", "sunset"];

// Appearance: color theme preference (Profile → Appearance). Persisted per
// user so it follows them across devices/sessions, not just this browser.
router.put("/me/theme", async (req, res, next) => {
  try {
    const { colorTheme } = req.body;
    if (!VALID_COLOR_THEMES.includes(colorTheme)) {
      return res.status(400).json({ error: "Unknown color theme." });
    }
    const { rows } = await pool.query(
      `UPDATE users SET color_theme = $1 WHERE id = $2 RETURNING color_theme`,
      [colorTheme, req.user.id]
    );
    invalidateUserCache(req.user.id);
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// Pending team invitations for the logged-in user.
router.get("/me/invites", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.team_id, i.role, i.created_at, t.name AS team_name, t.icon AS team_icon, t.description AS team_description, u.full_name AS inviter_name
       FROM team_invites i
       JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE LOWER(i.email) = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [req.user.email.toLowerCase()]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Teams the current user belongs to (used by the main page and team switcher).
router.get("/me/teams", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        t.id,
        t.name,
        t.description,
        t.icon,
        t.purpose,
        t.owner_id,
        t.created_at,
        tm.role,
        COALESCE(tm_cnt.member_count, 0)::int AS member_count,
        COALESCE(tsk.task_count, 0)::int AS task_count,
        COALESCE(tsk.completed_count, 0)::int AS completed_count,
        COALESCE(tsk.in_progress_count, 0)::int AS in_progress_count,
        COALESCE(tsk.todo_count, 0)::int AS todo_count,
        COALESCE(tsk.overdue_count, 0)::int AS overdue_count
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
       LEFT JOIN (
         SELECT team_id, COUNT(*) AS member_count FROM team_members GROUP BY team_id
       ) tm_cnt ON tm_cnt.team_id = t.id
       LEFT JOIN (
         SELECT
           team_id,
           COUNT(*) AS task_count,
           COUNT(*) FILTER (WHERE status = 'complete') AS completed_count,
           COUNT(*) FILTER (WHERE status = 'in_progress' AND (deadline >= CURRENT_DATE OR deadline IS NULL)) AS in_progress_count,
           COUNT(*) FILTER (WHERE status = 'todo' AND (deadline >= CURRENT_DATE OR deadline IS NULL)) AS todo_count,
           COUNT(*) FILTER (WHERE status <> 'complete' AND deadline < CURRENT_DATE) AS overdue_count
         FROM tasks
         GROUP BY team_id
       ) tsk ON tsk.team_id = t.id
       ORDER BY t.created_at ASC`,
      [req.user.id]
    );

    const enriched = rows.map((r) => ({
      ...r,
      completion_pct: r.task_count === 0 ? 0 : Math.round((r.completed_count / r.task_count) * 100),
    }));

    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

// Tasks assigned to the current user across all teams they belong to.
router.get("/me/assigned-tasks", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        tasks.*,
        users.full_name AS assignee_name,
        teams.name AS team_name,
        teams.icon AS team_icon
       FROM tasks
       JOIN teams ON teams.id = tasks.team_id
       JOIN team_members ON team_members.team_id = teams.id AND team_members.user_id = $1
       LEFT JOIN users ON users.id = tasks.assignee_id
       WHERE tasks.assignee_id = $1
       ORDER BY tasks.deadline ASC, tasks.created_at DESC`,
      [req.user.id]
    );

    const enriched = rows.map((row) => ({
      ...enrichTask(row),
      teamName: row.team_name,
      teamIcon: row.team_icon,
    }));

    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
