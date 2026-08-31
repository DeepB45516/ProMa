// routes/tasks.js — mounted at /api/teams/:teamId/tasks
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireAuth, requireTeamMember } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");
const { createNotification } = require("../lib/notifications");
const { sendTaskAssignmentEmail } = require("../lib/email");
const { dispatchTrackedEmail } = require("../lib/emailTracking");

const router = express.Router({ mergeParams: true });
const genId = () => crypto.randomUUID();

router.use(requireAuth, requireTeamMember);

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.full_name AS assignee_name, u.avatar_url AS assignee_avatar
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.team_id = $1
       ORDER BY t.deadline ASC NULLS LAST`,
      [req.params.teamId]
    );
    res.json(rows.map(enrichTask));
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    if (req.teamRole !== "owner" && req.teamRole !== "admin") {
      return res.status(403).json({ error: "Only team admins and owners have permission to add activities." });
    }

    const { title, description, assigneeId, startDate, deadline, priority, checklist } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "Activity name is required." });
    if (!deadline) return res.status(400).json({ error: "Deadline is required." });

    const today = new Date().toISOString().slice(0, 10);
    if (deadline < today) return res.status(400).json({ error: "Deadline cannot be in the past." });
    if (startDate && startDate < today) return res.status(400).json({ error: "Start date cannot be in the past." });

    if (assigneeId) {
      const member = await pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [req.params.teamId, assigneeId]
      );
      if (!member.rows[0]) return res.status(400).json({ error: "You can only assign activities to team members." });
    }

    const cleanPriority = ["low", "normal", "high", "urgent"].includes(priority) ? priority : "normal";
    const cleanChecklist = Array.isArray(checklist) ? JSON.stringify(checklist) : "[]";

    const id = genId();
    const { rows } = await pool.query(
      `INSERT INTO tasks (id, team_id, title, description, assignee_id, start_date, deadline, priority, checklist, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        req.params.teamId,
        title.trim(),
        (description || "").trim(),
        assigneeId || null,
        startDate || null,
        deadline,
        cleanPriority,
        cleanChecklist,
        req.user.id,
      ]
    );

    const assignee = assigneeId
      ? (await pool.query(`SELECT full_name, email, avatar_url, notif_email, notif_assignment FROM users WHERE id = $1`, [assigneeId])).rows[0]
      : null;

    const { rows: teamRows } = await pool.query(`SELECT name FROM teams WHERE id = $1`, [req.params.teamId]);
    const teamName = teamRows[0]?.name || "Team";

    // Send assignment notification & email
    if (assigneeId && assigneeId !== req.user.id) {
      await createNotification({
        userId: assigneeId,
        teamId: req.params.teamId,
        activityId: id,
        type: "task_assigned",
        title: "New Activity Assigned",
        message: `${req.user.full_name} (@${req.user.username}) assigned you: "${title.trim()}".`,
        link: `/teams/${req.params.teamId}/tasks`,
      });

      if (assignee && assignee.notif_email !== false && assignee.notif_assignment !== false) {
        // Task is already saved and the in-app notification already
        // created above — the email is dispatched in the background so the
        // browser doesn't wait on the mail provider before showing the
        // task as assigned.
        dispatchTrackedEmail({
          userId: assigneeId,
          activityId: id,
          type: "task_assigned",
          sendFn: () =>
            sendTaskAssignmentEmail({
              to: assignee.email,
              recipientName: assignee.full_name,
              taskTitle: title.trim(),
              taskDescription: (description || "").trim(),
              teamName,
              assignedBy: req.user.full_name,
              assignedByUsername: req.user.username,
              dueDate: deadline,
              status: "To Do",
              taskUrl: `${process.env.APP_URL || "http://localhost:3000"}/teams/${req.params.teamId}/tasks`,
            }),
        }).catch(() => {});
      }
    }

    res.status(201).json(
      enrichTask({
        ...rows[0],
        assignee_name: assignee?.full_name,
        assignee_avatar: assignee?.avatar_url,
      })
    );
  } catch (e) {
    next(e);
  }
});

router.put("/:taskId", async (req, res, next) => {
  try {
    const { title, description, assigneeId, startDate, deadline, status, priority, checklist } = req.body;

    const existingTask = (await pool.query(`SELECT * FROM tasks WHERE id = $1 AND team_id = $2`, [req.params.taskId, req.params.teamId])).rows[0];
    if (!existingTask) return res.status(404).json({ error: "Activity not found." });

    // Authorization: only the assigned member, the task creator, or a team admin/owner can update the task
    const isAssignee = existingTask.assignee_id && existingTask.assignee_id === req.user.id;
    const isCreator = existingTask.created_by && existingTask.created_by === req.user.id;
    const isManager = ["owner", "admin"].includes(req.teamRole);
    const isUnassigned = !existingTask.assignee_id;

    if (!isAssignee && !isCreator && !isManager && !isUnassigned) {
      return res.status(403).json({ error: "Only the member whom this activity is assigned can update its status or details." });
    }

    if (assigneeId) {
      const member = await pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [req.params.teamId, assigneeId]
      );
      if (!member.rows[0]) return res.status(400).json({ error: "You can only assign activities to team members." });
    }
    if (status && !["todo", "in_progress", "complete"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (title !== undefined && title.trim()) { fields.push(`title = $${i++}`); values.push(title.trim()); }
    if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description); }
    if (assigneeId !== undefined) { fields.push(`assignee_id = $${i++}`); values.push(assigneeId || null); }
    if (startDate !== undefined) { fields.push(`start_date = $${i++}`); values.push(startDate || null); }
    if (deadline !== undefined && deadline) { fields.push(`deadline = $${i++}`); values.push(deadline); }
    if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
    if (priority !== undefined && ["low", "normal", "high", "urgent"].includes(priority)) {
      fields.push(`priority = $${i++}`); values.push(priority);
    }
    if (checklist !== undefined && Array.isArray(checklist)) {
      fields.push(`checklist = $${i++}`); values.push(JSON.stringify(checklist));
    }
    fields.push(`updated_at = now()`);

    if (fields.length === 1) return res.status(400).json({ error: "Nothing to update." });

    values.push(req.params.taskId, req.params.teamId);
    const { rows } = await pool.query(
      `UPDATE tasks SET ${fields.join(", ")} WHERE id = $${i++} AND team_id = $${i} RETURNING *`,
      values
    );

    const updatedTask = rows[0];
    const assignee = updatedTask.assignee_id
      ? (await pool.query(`SELECT full_name, email, avatar_url, notif_email, notif_assignment FROM users WHERE id = $1`, [updatedTask.assignee_id])).rows[0]
      : null;

    const { rows: teamRows } = await pool.query(`SELECT name FROM teams WHERE id = $1`, [req.params.teamId]);
    const teamName = teamRows[0]?.name || "Team";

    // Detect reassignment or new assignment
    const isReassigned = assigneeId !== undefined && assigneeId !== existingTask.assignee_id && assigneeId !== null;

    if (isReassigned && assigneeId !== req.user.id) {
      await createNotification({
        userId: assigneeId,
        teamId: req.params.teamId,
        activityId: req.params.taskId,
        type: "task_reassigned",
        title: "Activity Reassigned to You",
        message: `${req.user.full_name} (@${req.user.username}) assigned activity "${updatedTask.title}" to you.`,
        link: `/teams/${req.params.teamId}/tasks`,
      });

      if (assignee && assignee.notif_email !== false && assignee.notif_assignment !== false) {
        dispatchTrackedEmail({
          userId: assigneeId,
          activityId: req.params.taskId,
          type: "task_assigned",
          sendFn: () =>
            sendTaskAssignmentEmail({
              to: assignee.email,
              recipientName: assignee.full_name,
              taskTitle: updatedTask.title,
              taskDescription: updatedTask.description,
              teamName,
              assignedBy: req.user.full_name,
              assignedByUsername: req.user.username,
              dueDate: updatedTask.deadline ? String(updatedTask.deadline).slice(0, 10) : "No deadline",
              status: updatedTask.status,
              taskUrl: `${process.env.APP_URL || "http://localhost:3000"}/teams/${req.params.teamId}/tasks`,
            }),
        }).catch(() => {});
      }
    }

    // If the deadline or assignee changed, clear any previously-recorded
    // due/overdue reminder emails for this task so the scheduled reminder
    // job re-evaluates and re-sends against the new deadline/assignee
    // instead of treating it as "already notified" forever (see lib/reminders.js).
    if (deadline !== undefined || assigneeId !== undefined) {
      pool
        .query(
          `DELETE FROM email_notifications WHERE activity_id = $1 AND notification_type IN ('due_today','overdue')`,
          [req.params.taskId]
        )
        .catch((e) => console.warn("Failed to reset reminder tracking:", e.message));
    }

    res.json(
      enrichTask({
        ...rows[0],
        assignee_name: assignee?.full_name,
        assignee_avatar: assignee?.avatar_url,
      })
    );
  } catch (e) {
    next(e);
  }
});

// Comments subroutes
router.get("/:taskId/comments", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.id AS user_id, u.full_name, u.username, u.avatar_url
       FROM task_comments c
       JOIN users u ON u.id = c.user_id
       JOIN tasks t ON t.id = c.task_id
       WHERE c.task_id = $1 AND t.team_id = $2
       ORDER BY c.created_at ASC`,
      [req.params.taskId, req.params.teamId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/:taskId/comments", async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: "Comment content is required." });

    // Verify task exists in team
    const taskRes = await pool.query(
      `SELECT id, title, assignee_id FROM tasks WHERE id = $1 AND team_id = $2`,
      [req.params.taskId, req.params.teamId]
    );
    if (!taskRes.rows[0]) return res.status(404).json({ error: "Activity not found." });
    const task = taskRes.rows[0];

    const commentId = genId();
    await pool.query(
      `INSERT INTO task_comments (id, task_id, user_id, content) VALUES ($1, $2, $3, $4)`,
      [commentId, req.params.taskId, req.user.id, content.trim()]
    );

    // Notify assignee if not commenter
    if (task.assignee_id && task.assignee_id !== req.user.id) {
      await createNotification({
        userId: task.assignee_id,
        title: "New Comment on Activity",
        message: `${req.user.full_name} commented on "${task.title}": "${content.trim().slice(0, 80)}"`,
        link: `/teams/${req.params.teamId}/tasks`,
      });
    }

    // Parse @mentions (e.g. @username)
    const mentions = content.match(/@([a-zA-Z0-9_-]+)/g);
    if (mentions) {
      const usernames = mentions.map((m) => m.slice(1).toLowerCase());
      for (const uname of usernames) {
        if (uname !== req.user.username?.toLowerCase()) {
          const mentionedUser = await pool.query(
            `SELECT u.id FROM users u
             JOIN team_members tm ON tm.user_id = u.id
             WHERE LOWER(u.username) = $1 AND tm.team_id = $2`,
            [uname, req.params.teamId]
          );
          if (mentionedUser.rows[0]) {
            await createNotification({
              userId: mentionedUser.rows[0].id,
              title: "Mentioned in Activity",
              message: `${req.user.full_name} mentioned you on "${task.title}".`,
              link: `/teams/${req.params.teamId}/tasks`,
            });
          }
        }
      }
    }

    res.status(201).json({
      id: commentId,
      content: content.trim(),
      created_at: new Date().toISOString(),
      user_id: req.user.id,
      full_name: req.user.full_name,
      username: req.user.username,
      avatar_url: req.user.avatar_url,
    });
  } catch (e) {
    next(e);
  }
});

router.delete("/:taskId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { taskId, teamId } = req.params;

    if (req.teamRole !== "owner" && req.teamRole !== "admin") {
      return res.status(403).json({ error: "Only team admins and owners have permission to delete activities." });
    }

    await client.query("BEGIN");
    const existing = await client.query(`SELECT id FROM tasks WHERE id = $1 AND team_id = $2`, [taskId, teamId]);
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Activity not found." });
    }

    await client.query(`DELETE FROM task_comments WHERE task_id = $1`, [taskId]);
    await client.query(`DELETE FROM email_notifications WHERE activity_id = $1`, [taskId]);
    await client.query(`DELETE FROM notifications WHERE activity_id = $1`, [taskId]);
    await client.query(`DELETE FROM tasks WHERE id = $1 AND team_id = $2`, [taskId, teamId]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

module.exports = router;
