// routes/dashboard.js — mounted at /api/teams/:teamId/dashboard
const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireTeamMember } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");
const { computeDashboardStats } = require("../lib/dashboardStats");

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireTeamMember);

router.get("/", async (req, res, next) => {
  try {
    const { teamId } = req.params;

    const { rows: taskRows } = await pool.query(
      `SELECT t.*, u.full_name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.team_id = $1`,
      [teamId]
    );
    const tasks = taskRows.map(enrichTask);

    const { rows: members } = await pool.query(
      `SELECT u.id, u.full_name, tm.role
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1`,
      [teamId]
    );

    const { rows: recent } = await pool.query(
      `SELECT t.id, t.title, t.status, t.updated_at, u.full_name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.team_id = $1 ORDER BY t.updated_at DESC LIMIT 6`,
      [teamId]
    );

    res.json({
      ...computeDashboardStats(tasks, members),
      recentActivity: recent,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
