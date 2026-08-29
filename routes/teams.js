// routes/teams.js
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireAuth, requireTeamMember, requireTeamAdmin } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");
const { computeDashboardStats } = require("../lib/dashboardStats");
const { sendTeamInviteEmail } = require("../lib/email");
const { createNotification } = require("../lib/notifications");
const { dispatchTrackedEmail } = require("../lib/emailTracking");

const router = express.Router();
const genId = () => crypto.randomUUID();
router.use(requireAuth);

// The frontend renders team.icon with innerHTML (it's meant to hold a single
// emoji), so it must never be allowed to carry HTML/script content. Keep it
// short and reject anything containing '<' — a single emoji never needs it.
function cleanIcon(icon, fallback) {
  if (!icon || typeof icon !== "string") return fallback;
  const trimmed = icon.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 16 || trimmed.includes("<")) return fallback;
  return trimmed;
}

// ---------- create team ----------
router.post("/", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, description, icon, purpose, memberEmails } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Team name is required." });

    await client.query("BEGIN");
    const teamId = genId();
    const { rows } = await client.query(
      `INSERT INTO teams (id, name, description, icon, purpose, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [teamId, name.trim(), (description || "").trim(), cleanIcon(icon, "🚀"), (purpose || "").trim(), req.user.id]
    );
    await client.query(
      `INSERT INTO team_members (id, team_id, user_id, role) VALUES ($1,$2,$3,'owner')`,
      [genId(), teamId, req.user.id]
    );

    const emails = (memberEmails || [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && e !== req.user.email);

    for (const email of emails) {
      const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (existing.rows[0]) {
        await client.query(
          `INSERT INTO team_members (id, team_id, user_id, role) VALUES ($1,$2,$3,'member')
           ON CONFLICT (team_id, user_id) DO NOTHING`,
          [genId(), teamId, existing.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO team_invites (id, team_id, email, role, token, invited_by)
           VALUES ($1,$2,$3,'member',$4,$5)`,
          [genId(), teamId, email, crypto.randomBytes(16).toString("hex"), req.user.id]
        );
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ ...rows[0], role: "owner" });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

// ---------- high-speed team bundle (1 parallel burst round-trip) ----------
router.get("/:teamId/bundle", async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const [teamRes, membersRes, invitesRes, taskRows] = await Promise.all([
      pool.query(`SELECT * FROM teams WHERE id = $1`, [teamId]),
      pool.query(
        `SELECT u.id, u.full_name, u.username, u.email, u.avatar_url, u.designation, tm.role, tm.joined_at
         FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 ORDER BY tm.joined_at ASC`,
        [teamId]
      ),
      pool.query(
        `SELECT id, email, role, token, created_at FROM team_invites WHERE team_id = $1 AND status = 'pending'`,
        [teamId]
      ),
      pool.query(
        `SELECT t.*, u.full_name AS assignee_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.team_id = $1 ORDER BY t.deadline ASC NULLS LAST`,
        [teamId]
      ),
    ]);

    if (!teamRes.rows[0]) return res.status(404).json({ error: "Team not found." });

    const members = membersRes.rows;
    const myMembership = members.find((m) => m.id === req.user.id);
    if (!myMembership) {
      return res.status(403).json({ error: "You're not a member of this team." });
    }

    const team = { ...teamRes.rows[0], role: myMembership.role };
    const pendingInvites = invitesRes.rows;
    const tasks = taskRows.rows.map(enrichTask);

    const recent = [...tasks]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 6)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        updated_at: t.updatedAt,
        assignee_name: t.assigneeName,
      }));

    const dashboard = {
      ...computeDashboardStats(tasks, members),
      recentActivity: recent,
      generatedAt: new Date().toISOString(),
    };

    res.json({ team, members, pendingInvites, tasks, dashboard });
  } catch (e) {
    next(e);
  }
});

// ---------- monthly report endpoint (1-click professional report) ----------
router.get("/:teamId/reports/monthly", requireTeamMember, async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // e.g. "2026-08"

    const [teamRes, membersRes, tasksRes] = await Promise.all([
      pool.query(`SELECT * FROM teams WHERE id = $1`, [teamId]),
      pool.query(
        `SELECT u.id, u.full_name, u.username, u.email, u.avatar_url, u.designation, tm.role
         FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 ORDER BY tm.joined_at ASC`,
        [teamId]
      ),
      pool.query(
        `SELECT t.*, u.full_name AS assignee_name, u.email AS assignee_email
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.team_id = $1
         ORDER BY t.deadline ASC NULLS LAST`,
        [teamId]
      ),
    ]);

    if (!teamRes.rows[0]) return res.status(404).json({ error: "Team not found." });

    const team = { ...teamRes.rows[0], role: req.teamRole };
    const members = membersRes.rows;
    const allTasks = tasksRes.rows.map(enrichTask);

    // Filter tasks active or relevant to this month (by deadline, start date, creation, or update)
    const filteredTasks = allTasks.filter((t) => {
      const inMonth = (d) => d && d.startsWith(month);
      return inMonth(t.deadline) || inMonth(t.startDate) || inMonth(t.createdAt?.slice(0, 7)) || inMonth(t.updatedAt?.slice(0, 7));
    });

    const reportTasks = filteredTasks.length > 0 ? filteredTasks : allTasks;

    const total = reportTasks.length;
    const countBy = (s) => reportTasks.filter((t) => t.effectiveStatus === s).length;
    const todo = countBy("todo");
    const inProgress = countBy("in_progress");
    const complete = countBy("complete");
    const overdue = countBy("overdue");
    const completionPct = total === 0 ? 0 : Math.round((complete / total) * 100);

    const memberBreakdown = members.map((m) => {
      const mine = reportTasks.filter((t) => t.assigneeId === m.id);
      const mineComplete = mine.filter((t) => t.effectiveStatus === "complete").length;
      const mineInProgress = mine.filter((t) => t.effectiveStatus === "in_progress").length;
      const mineTodo = mine.filter((t) => t.effectiveStatus === "todo").length;
      const mineOverdue = mine.filter((t) => t.effectiveStatus === "overdue").length;
      return {
        member: m,
        total: mine.length,
        complete: mineComplete,
        inProgress: mineInProgress,
        todo: mineTodo,
        overdue: mineOverdue,
        completionPct: mine.length === 0 ? 0 : Math.round((mineComplete / mine.length) * 100),
        tasks: mine,
      };
    });

    const unassignedTasks = reportTasks.filter((t) => !t.assigneeId);

    const monthDate = new Date(month + "-01T00:00:00");
    const periodLabel = isNaN(monthDate.getTime())
      ? month
      : monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    res.json({
      period: month,
      periodLabel,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user.full_name,
      team,
      kpis: {
        total,
        todo,
        inProgress,
        complete,
        overdue,
        completionPct,
        totalMembers: members.length,
        activeMembers: memberBreakdown.filter((m) => m.total > 0).length,
      },
      memberBreakdown,
      unassignedTasks,
    });
  } catch (e) {
    next(e);
  }
});

// ---------- team detail ----------
router.get("/:teamId", requireTeamMember, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM teams WHERE id = $1`, [req.params.teamId]);
    if (!rows[0]) return res.status(404).json({ error: "Team not found." });
    res.json({ ...rows[0], role: req.teamRole });
  } catch (e) {
    next(e);
  }
});

router.put("/:teamId", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    const { name, description, icon, purpose } = req.body;
    const { rows } = await pool.query(
      `UPDATE teams SET
         name = COALESCE(NULLIF($1,''), name),
         description = COALESCE($2, description),
         icon = COALESCE(NULLIF($3,''), icon),
         purpose = COALESCE($4, purpose)
       WHERE id = $5 RETURNING *`,
      [name?.trim(), description, cleanIcon(icon, ""), purpose, req.params.teamId]
    );
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.delete("/:teamId", requireTeamMember, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.teamRole !== "owner") return res.status(403).json({ error: "Only the team owner can delete this team." });
    const { teamId } = req.params;

    await client.query("BEGIN");
    const taskIds = await client.query(`SELECT id FROM tasks WHERE team_id = $1`, [teamId]);
    const ids = taskIds.rows.map((row) => row.id);

    if (ids.length > 0) {
      await client.query(`DELETE FROM task_comments WHERE task_id = ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM email_notifications WHERE activity_id = ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM notifications WHERE activity_id = ANY($1::text[])`, [ids]);
    }

    await client.query(`DELETE FROM notifications WHERE team_id = $1`, [teamId]);
    await client.query(`DELETE FROM tasks WHERE team_id = $1`, [teamId]);
    await client.query(`DELETE FROM team_invites WHERE team_id = $1`, [teamId]);
    await client.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
    const { rowCount } = await client.query(`DELETE FROM teams WHERE id = $1 AND owner_id = $2`, [teamId, req.user.id]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Team not found." });
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// ---------- members ----------
router.get("/:teamId/members", requireTeamMember, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.avatar_url, u.designation, tm.role, tm.joined_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 ORDER BY tm.joined_at ASC`,
      [req.params.teamId]
    );
    const { rows: invites } = await pool.query(
      `SELECT id, email, role, token, created_at FROM team_invites WHERE team_id = $1 AND status = 'pending'`,
      [req.params.teamId]
    );
    res.json({ members: rows, pendingInvites: invites });
  } catch (e) {
    next(e);
  }
});

// Accept team invitation
router.post("/invites/:inviteId/accept", async (req, res, next) => {
  try {
    const { rows: invites } = await pool.query(
      `SELECT i.*, t.name AS team_name FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.id = $1 AND LOWER(i.email) = $2 AND i.status = 'pending'`,
      [req.params.inviteId, req.user.email.toLowerCase()]
    );
    const invite = invites[0];
    if (!invite) return res.status(404).json({ error: "Invitation not found or already processed." });

    await pool.query(
      `INSERT INTO team_members (id, team_id, user_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [genId(), invite.team_id, req.user.id, invite.role]
    );

    await pool.query(`UPDATE team_invites SET status = 'accepted' WHERE id = $1`, [invite.id]);

    if (invite.invited_by) {
      await createNotification({
        userId: invite.invited_by,
        teamId: invite.team_id,
        type: "team_invite_accepted",
        title: "Invitation Accepted",
        message: `${req.user.full_name} accepted your invitation to join "${invite.team_name}".`,
        link: `/teams/${invite.team_id}`,
      });
    }

    res.json({ ok: true, teamId: invite.team_id });
  } catch (e) {
    next(e);
  }
});

// Decline team invitation
router.post("/invites/:inviteId/decline", async (req, res, next) => {
  try {
    const { rows: invites } = await pool.query(
      `SELECT i.*, t.name AS team_name FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.id = $1 AND LOWER(i.email) = $2 AND i.status = 'pending'`,
      [req.params.inviteId, req.user.email.toLowerCase()]
    );
    const invite = invites[0];
    if (!invite) return res.status(404).json({ error: "Invitation not found or already processed." });

    await pool.query(`UPDATE team_invites SET status = 'declined' WHERE id = $1`, [invite.id]);

    if (invite.invited_by) {
      await createNotification({
        userId: invite.invited_by,
        teamId: invite.team_id,
        type: "team_invite_declined",
        title: "Invitation Declined",
        message: `${req.user.full_name} declined your invitation to join "${invite.team_name}".`,
        link: `/teams/${invite.team_id}`,
      });
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:teamId/members", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    const { identifier, role } = req.body;
    if (!identifier?.trim()) return res.status(400).json({ error: "Enter an email or username." });
    const clean = identifier.trim().toLowerCase();
    const assignRole = ["admin", "member"].includes(role) ? role : "member";

    const { rows: teamRows } = await pool.query(`SELECT name FROM teams WHERE id = $1`, [req.params.teamId]);
    const teamName = teamRows[0]?.name || "Team";

    const { rows: userRows } = await pool.query(
      `SELECT * FROM users WHERE email = $1 OR username = $1`,
      [clean]
    );

    const targetUser = userRows[0];

    if (targetUser) {
      const already = await pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [req.params.teamId, targetUser.id]
      );
      if (already.rows[0]) return res.status(409).json({ error: "That person is already on the team." });

      const existingInvite = await pool.query(
        `SELECT id FROM team_invites WHERE team_id = $1 AND email = $2 AND status = 'pending'`,
        [req.params.teamId, targetUser.email]
      );
      if (existingInvite.rows[0]) {
        return res.status(409).json({ error: "An invite is already pending for that user." });
      }

      const token = crypto.randomBytes(16).toString("hex");
      const inviteId = genId();
      await pool.query(
        `INSERT INTO team_invites (id, team_id, email, role, token, invited_by, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [inviteId, req.params.teamId, targetUser.email, assignRole, token, req.user.id]
      );

      const inviteUrl = `${process.env.APP_URL || "http://localhost:3000"}/?invite=${token}`;

      // Send email if user has notif_email and notif_team_invites enabled.
      // Dispatched in the background so adding a member responds instantly
      // instead of waiting on the mail provider.
      if (targetUser.notif_email !== false && targetUser.notif_team_invites !== false) {
        dispatchTrackedEmail({
          userId: targetUser.id,
          activityId: null,
          type: "team_invite",
          sendFn: () =>
            sendTeamInviteEmail({
              to: targetUser.email,
              teamName,
              invitedBy: req.user.full_name,
              inviteUrl,
            }),
        }).catch(() => {});
      }

      // Create in-app notification
      await createNotification({
        userId: targetUser.id,
        teamId: req.params.teamId,
        type: "team_invite",
        title: "Team Invitation",
        message: `${req.user.full_name} invited you to join team "${teamName}".`,
        link: "/main",
      });

      return res.status(201).json({
        added: false,
        invited: true,
        userExists: true,
        inviteLink: inviteUrl,
        message: `Invitation sent to ${targetUser.full_name} (${targetUser.email}).`,
      });
    }

    // No matching account — invite by email
    if (!clean.includes("@")) {
      return res.status(404).json({ error: "No account found with that username. Invite by email instead." });
    }
    const existingInvite = await pool.query(
      `SELECT id FROM team_invites WHERE team_id = $1 AND email = $2 AND status = 'pending'`,
      [req.params.teamId, clean]
    );
    if (existingInvite.rows[0]) {
      return res.status(409).json({ error: "An invite is already pending for that email." });
    }
    const token = crypto.randomBytes(16).toString("hex");
    await pool.query(
      `INSERT INTO team_invites (id, team_id, email, role, token, invited_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [genId(), req.params.teamId, clean, assignRole, token, req.user.id]
    );

    const inviteUrl = `${process.env.APP_URL || "http://localhost:3000"}/?invite=${token}`;
    // No account exists yet for this email, so there's no user_id to track
    // delivery against — just fire the send in the background so the invite
    // is created and the response returns without waiting on the mail
    // provider. A failed send here isn't fatal: the invite link itself
    // still works if the person is given it directly.
    sendTeamInviteEmail({
      to: clean,
      teamName,
      invitedBy: req.user.full_name,
      inviteUrl,
    }).catch((err) => console.error("[email] Team invite send failed:", err.message));

    res.status(201).json({
      added: false,
      invited: true,
      userExists: false,
      inviteLink: inviteUrl,
      message: `Invitation email sent to ${clean}.`,
    });
  } catch (e) {
    next(e);
  }
});

router.put("/:teamId/members/:userId", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["admin", "member"].includes(role)) return res.status(400).json({ error: "Role must be admin or member." });

    const target = await pool.query(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [req.params.teamId, req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: "That person isn't on this team." });
    if (target.rows[0].role === "owner") return res.status(403).json({ error: "The team owner's role can't be changed." });

    await pool.query(
      `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`,
      [role, req.params.teamId, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete("/:teamId/members/:userId", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    const target = await pool.query(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [req.params.teamId, req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: "That person isn't on this team." });
    if (target.rows[0].role === "owner") return res.status(403).json({ error: "The team owner can't be removed." });

    await pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [req.params.teamId, req.params.userId]);
    await pool.query(
      `UPDATE tasks SET assignee_id = NULL WHERE team_id = $1 AND assignee_id = $2`,
      [req.params.teamId, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:teamId/invites/:inviteId/resend", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    const { rows: invites } = await pool.query(
      `SELECT i.*, t.name AS team_name FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.id = $1 AND i.team_id = $2 AND i.status = 'pending'`,
      [req.params.inviteId, req.params.teamId]
    );
    const invite = invites[0];
    if (!invite) return res.status(404).json({ error: "Pending invitation not found." });

    const inviteUrl = `${process.env.APP_URL || "http://localhost:3000"}/?invite=${invite.token}`;

    sendTeamInviteEmail({
      to: invite.email,
      teamName: invite.team_name,
      invitedBy: req.user.full_name,
      inviteUrl,
    }).catch((err) => console.error("[email] Team invite resend failed:", err.message));

    res.json({ ok: true, inviteLink: inviteUrl, message: `Invitation resent to ${invite.email}.` });
  } catch (e) {
    next(e);
  }
});

router.delete("/:teamId/invites/:inviteId", requireTeamMember, requireTeamAdmin, async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM team_invites WHERE id = $1 AND team_id = $2`, [req.params.inviteId, req.params.teamId]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
