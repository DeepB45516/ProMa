// middleware/auth.js
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");

const COOKIE_NAME = "basecamp_session";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";
const TOKEN_TTL = "30d";

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, userId) {
  const token = signToken(userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// In-memory cache for fast user session lookups (avoids repeated DB roundtrips)
const userCache = new Map();
const USER_CACHE_TTL = 60 * 1000;

function getCachedUser(uid) {
  const item = userCache.get(uid);
  if (!item) return null;
  if (Date.now() - item.ts > USER_CACHE_TTL) {
    userCache.delete(uid);
    return null;
  }
  return item.user;
}

function setCachedUser(uid, user) {
  userCache.set(uid, { user, ts: Date.now() });
}

function invalidateUserCache(uid) {
  if (uid) userCache.delete(uid);
}

// Attaches req.user if a valid session cookie is present; never blocks.
async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return next();
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.uid) return next();

    const cached = getCachedUser(payload.uid);
    if (cached) {
      req.user = cached;
      return next();
    }

    const { rows } = await pool.query(
      `SELECT id, full_name, username, email, mobile, avatar_url, bio, designation,
              notif_email, notif_overdue, notif_assignment, notif_due_reminders, notif_team_invites,
              color_theme, created_at
       FROM users WHERE id = $1`,
      [payload.uid]
    );
    if (rows[0]) {
      req.user = rows[0];
      setCachedUser(payload.uid, rows[0]);
    }
  } catch (e) {
    // invalid/expired token — treat as logged out
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}

// Loads membership for :teamId and attaches req.teamRole ("owner"|"admin"|"member").
async function requireTeamMember(req, res, next) {
  try {
    const { teamId } = req.params;
    const { rows } = await pool.query(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, req.user.id]
    );
    if (!rows[0]) return res.status(403).json({ error: "You're not a member of this team." });
    req.teamRole = rows[0].role;
    next();
  } catch (e) {
    next(e);
  }
}

function requireTeamAdmin(req, res, next) {
  if (!["owner", "admin"].includes(req.teamRole)) {
    return res.status(403).json({ error: "Only team owners and admins can do that." });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireTeamMember,
  requireTeamAdmin,
  invalidateUserCache,
};
