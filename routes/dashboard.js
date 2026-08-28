// routes/dashboard.js — mounted at /api/teams/:teamId/dashboard
const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireTeamMember } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");

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

    const total = tasks.length;
    const countBy = (s) => tasks.filter((t) => t.effectiveStatus === s).length;
    const todo = countBy("todo");
    const inProgress = countBy("in_progress");
    const complete = countBy("complete");
    const overdue = countBy("overdue");
    const completionPct = total === 0 ? 0 : Math.round((complete / total) * 100);

    const upcoming = tasks
      .filter((t) => t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue")
      .sort((a, b) => String(a.deadline || "").localeCompare(String(b.deadline || "")))
      .slice(0, 5);

    const overdueTasks = tasks
      .filter((t) => t.effectiveStatus === "overdue")
      .sort((a, b) => String(a.deadline || "").localeCompare(String(b.deadline || "")));

    const memberProgress = members.map((m) => {
      const mine = tasks.filter((t) => t.assigneeId === m.id);
      const mineComplete = mine.filter((t) => t.effectiveStatus === "complete").length;
      return {
        id: m.id,
        name: m.full_name,
        role: m.role,
        total: mine.length,
        complete: mineComplete,
        overdue: mine.filter((t) => t.effectiveStatus === "overdue").length,
        inProgress: mine.filter((t) => t.effectiveStatus === "in_progress").length,
        todo: mine.filter((t) => t.effectiveStatus === "todo").length,
        completionPct: mine.length === 0 ? 0 : Math.round((mineComplete / mine.length) * 100),
      };
    });

    res.json({
      total,
      todo,
      inProgress,
      complete,
      overdue,
      completionPct,
      memberCount: members.length,
      upcoming,
      overdueTasks,
      memberProgress,
      recentActivity: recent,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
