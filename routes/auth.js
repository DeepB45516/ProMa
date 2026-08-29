// routes/auth.js
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("../db/pool");
const { setAuthCookie, clearAuthCookie, requireAuth } = require("../middleware/auth");
const { sendVerificationOtpEmail, sendPasswordResetEmail } = require("../lib/email");
const { rateLimit } = require("../lib/rateLimit");

const router = express.Router();
const genId = () => crypto.randomUUID();

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---------- email validation & check ----------
router.post("/check-email", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    const cleanEmail = email.trim().toLowerCase();
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [cleanEmail]);
    res.json({ exists: Boolean(rows[0]), email: cleanEmail });
  } catch (e) {
    next(e);
  }
});

// ---------- email OTP send & verify ----------
router.post("/otp/email/send", rateLimit("otp-email-send", 5, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    const cleanEmail = email.trim().toLowerCase();

    const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [cleanEmail]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: "An account with this email already exists. Please log in." });
    }

    const recent = await pool.query(
      `SELECT created_at FROM otp_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail]
    );
    if (recent.rows[0]) {
      const elapsedSec = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
      if (elapsedSec < 60) {
        const waitSec = Math.ceil(60 - elapsedSec);
        return res.status(429).json({ error: `Please wait ${waitSec} second${waitSec === 1 ? "" : "s"} before requesting another code.` });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    await pool.query(
      `INSERT INTO otp_codes (id, mobile, email, code, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [genId(), `email:${cleanEmail}`, cleanEmail, "******", codeHash, expiresAt]
    );

    const result = await sendVerificationOtpEmail(cleanEmail, code);
    if (!result.ok && !result.devMode) {
      return res.status(500).json({ error: "Failed to deliver verification email. Please try again." });
    }

    res.json({ ok: true, message: "Verification code sent to your email." });
  } catch (e) {
    next(e);
  }
});

router.post("/otp/email/verify", rateLimit("otp-email-verify", 10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const { email, code, fullName, password, username } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    if (!code?.trim() || code.trim().length !== 6) {
      return res.status(400).json({ error: "Enter the 6-digit verification code sent to your email." });
    }
    if (!fullName?.trim() || !password || password.length < 8) {
      return res.status(400).json({ error: "Full name and password (at least 8 characters) are required." });
    }
    const cleanEmail = email.trim().toLowerCase();
    const codeHash = crypto.createHash("sha256").update(code.trim()).digest("hex");

    const { rows } = await pool.query(
      `SELECT * FROM otp_codes WHERE email = $1 AND consumed = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail]
    );
    const otpRecord = rows[0];
    if (!otpRecord) {
      return res.status(400).json({ error: "Verification code is invalid or has expired." });
    }
    if (otpRecord.attempts >= 5) {
      return res.status(429).json({ error: "Too many failed attempts. Please request a new verification code." });
    }

    const isMatch = otpRecord.code_hash === codeHash || otpRecord.code === code.trim();
    if (!isMatch) {
      await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [otpRecord.id]);
      return res.status(400).json({ error: "Invalid verification code." });
    }

    await pool.query(`UPDATE otp_codes SET consumed = TRUE WHERE id = $1`, [otpRecord.id]);

    const existingUser = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [cleanEmail]);
    if (existingUser.rows[0]) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const cleanUsername = (username?.trim() || usernameFromEmail(cleanEmail)).toLowerCase();
    const usernameTaken = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [cleanUsername]);
    const finalUsername = usernameTaken.rows[0] ? await uniqueUsername(cleanUsername) : cleanUsername;

    const hash = await bcrypt.hash(password, 10);
    const id = genId();
    const { rows: createdRows } = await pool.query(
      `INSERT INTO users (id, full_name, username, email, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, fullName.trim(), finalUsername, cleanEmail, hash]
    );

    await attachPendingInvites(id, cleanEmail);
    setAuthCookie(res, id);
    res.status(201).json({ user: publicUser(createdRows[0]) });
  } catch (e) {
    next(e);
  }
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL; // e.g. https://yourapp.onrender.com/api/auth/google/callback
const GOOGLE_CONFIGURED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL);

const isDev = process.env.NODE_ENV !== "production";

function publicUser(row) {
  if (!row) return null;
  const { password_hash, google_id, ...rest } = row;
  return rest;
}

async function attachPendingInvites(userId, email) {
  const { rows: invites } = await pool.query(
    `SELECT * FROM team_invites WHERE email = $1 AND status = 'pending'`,
    [email.toLowerCase()]
  );
  for (const invite of invites) {
    await pool.query(
      `INSERT INTO team_members (id, team_id, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [genId(), invite.team_id, userId, invite.role]
    );
    await pool.query(`UPDATE team_invites SET status = 'accepted' WHERE id = $1`, [invite.id]);
  }
}

function usernameFromEmail(email) {
  return email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").toLowerCase() || "user";
}

async function uniqueUsername(base) {
  let candidate = base;
  let n = 0;
  while (true) {
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [candidate]);
    if (!rows[0]) return candidate;
    n += 1;
    candidate = `${base}${n}`;
  }
}

// ---------- signup ----------
router.post("/signup", rateLimit("signup", 10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const { fullName, username, email, password } = req.body;
    if (!fullName?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = (username?.trim() || usernameFromEmail(cleanEmail)).toLowerCase();

    const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [cleanEmail]);
    if (existing.rows[0]) return res.status(409).json({ error: "An account with that email already exists." });

    const usernameTaken = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [cleanUsername]);
    const finalUsername = usernameTaken.rows[0] ? await uniqueUsername(cleanUsername) : cleanUsername;

    const hash = await bcrypt.hash(password, 10);
    const id = genId();
    const { rows } = await pool.query(
      `INSERT INTO users (id, full_name, username, email, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, fullName.trim(), finalUsername, cleanEmail, hash]
    );

    await attachPendingInvites(id, cleanEmail);
    setAuthCookie(res, id);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (e) {
    next(e);
  }
});

// ---------- login ----------
router.post("/login", rateLimit("login", 10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier?.trim() || !password) {
      return res.status(400).json({ error: "Enter your email/username and password." });
    }
    const clean = identifier.trim().toLowerCase();
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE email = $1 OR username = $1`,
      [clean]
    );
    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Incorrect email/username or password." });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect email/username or password." });

    await attachPendingInvites(user.id, user.email);

    setAuthCookie(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// ---------- logout ----------
router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ---------- current user ----------
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------- forgot / reset password ----------
router.post("/forgot-password", rateLimit("forgot-password", 5, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: "Enter your account email." });
    const clean = email.trim().toLowerCase();
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [clean]);

    // Always respond with identical wording whether or not the email
    // exists, so the response body can't be used to enumerate which
    // addresses have accounts.
    if (!rows[0]) {
      return res.json({ ok: true, message: "If that email has an account, a reset link has been sent." });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ($1,$2,$3,$4)`,
      [genId(), rows[0].id, token, expiresAt]
    );

    const resetPath = `/reset-password?token=${token}`;
    const resetUrl = `${process.env.APP_URL || "http://localhost:3000"}${resetPath}`;

    // Always send the reset link by email — never return the live token in
    // the API response. Returning it here would let anyone who knows a
    // user's email address reset that user's password without ever
    // touching their inbox, which is a full account-takeover path.
    const emailResult = await sendPasswordResetEmail({ to: clean, resetUrl });

    const response = {
      ok: true,
      message: "If that email has an account, a reset link has been sent.",
    };

    // Only in local development, and only when no real email provider is
    // configured (so the email would otherwise just be logged to the
    // console and the developer would have no way to click the link), echo
    // the link back for convenience. This never happens in production.
    if (isDev && emailResult.devMode) {
      response.resetLink = resetPath;
      response.devNote = "No email provider is configured, so the link is included here for local testing only.";
    }

    res.json(response);
  } catch (e) {
    next(e);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Missing token or new password." });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const { rows } = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > now()`,
      [token]
    );
    const record = rows[0];
    if (!record) return res.status(400).json({ error: "This reset link is invalid or has expired." });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, record.user_id]);
    await pool.query(`UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`, [record.id]);

    res.json({ ok: true, message: "Password updated. You can now log in." });
  } catch (e) {
    next(e);
  }
});

// ---------- mobile OTP login ----------
router.post("/otp/send", rateLimit("otp-send", 5, 15 * 60 * 1000), async (req, res, next) => {
  try {
    // No SMS provider is wired up yet. Returning/logging the code (as this
    // route used to) would let anyone log into any phone number's account
    // without ever receiving a text, so mobile OTP login is disabled in
    // production until a real SMS provider (Twilio / MSG91 / etc.) is
    // added. It still works in development for convenience.
    if (!isDev) {
      return res.status(503).json({ error: "Mobile sign-in isn't available yet. Please use email instead." });
    }

    const { mobile } = req.body;
    if (!mobile?.trim()) return res.status(400).json({ error: "Enter a mobile number." });
    const clean = mobile.trim();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(`INSERT INTO otp_codes (id, mobile, code, expires_at) VALUES ($1,$2,$3,$4)`, [
      genId(),
      clean,
      code,
      expiresAt,
    ]);
    console.log(`[otp] code for ${clean}: ${code}`);

    res.json({
      ok: true,
      message: "Verification code created.",
      code,
      devNote: "No SMS service is configured, so the code is shown here instead of being texted.",
    });
  } catch (e) {
    next(e);
  }
});

router.post("/otp/verify", async (req, res, next) => {
  try {
    const { mobile, code, fullName } = req.body;
    if (!mobile?.trim() || !code?.trim()) return res.status(400).json({ error: "Enter the code sent to your phone." });
    const clean = mobile.trim();

    const { rows } = await pool.query(
      `SELECT * FROM otp_codes WHERE mobile = $1 AND code = $2 AND consumed = FALSE AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [clean, code.trim()]
    );
    if (!rows[0]) return res.status(400).json({ error: "That code is invalid or has expired." });
    await pool.query(`UPDATE otp_codes SET consumed = TRUE WHERE id = $1`, [rows[0].id]);

    let { rows: userRows } = await pool.query(`SELECT * FROM users WHERE mobile = $1`, [clean]);
    let user = userRows[0];

    if (!user) {
      const id = genId();
      const placeholderEmail = `${clean.replace(/\D/g, "")}@mobile.local`;
      const username = await uniqueUsername(`user${clean.replace(/\D/g, "").slice(-6)}`);
      const created = await pool.query(
        `INSERT INTO users (id, full_name, username, email, mobile) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, fullName?.trim() || "New User", username, placeholderEmail, clean]
      );
      user = created.rows[0];
      await attachPendingInvites(id, placeholderEmail);
    }

    setAuthCookie(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// ---------- Google OAuth ----------
router.get("/google/status", (req, res) => {
  res.json({ configured: GOOGLE_CONFIGURED });
});

router.get("/google", (req, res) => {
  if (!GOOGLE_CONFIGURED) {
    return res.status(503).send("Google sign-in isn't configured on this server yet.");
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/google/callback", async (req, res, next) => {
  try {
    if (!GOOGLE_CONFIGURED) return res.status(503).send("Google sign-in isn't configured on this server yet.");
    const { code } = req.query;
    if (!code) return res.redirect("/?authError=Google sign-in was cancelled.");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect("/?authError=Google sign-in failed.");

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    let { rows } = await pool.query(`SELECT * FROM users WHERE google_id = $1 OR email = $2`, [
      profile.sub,
      (profile.email || "").toLowerCase(),
    ]);
    let user = rows[0];

    if (!user) {
      const id = genId();
      const username = await uniqueUsername(usernameFromEmail(profile.email || "user"));
      const created = await pool.query(
        `INSERT INTO users (id, full_name, username, email, google_id, avatar_url)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, profile.name || "New User", username, (profile.email || "").toLowerCase(), profile.sub, profile.picture]
      );
      user = created.rows[0];
      await attachPendingInvites(id, user.email);
    } else if (!user.google_id) {
      await pool.query(`UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3`, [
        profile.sub,
        profile.picture,
        user.id,
      ]);
    }

    await attachPendingInvites(user.id, user.email);

    setAuthCookie(res, user.id);
    res.redirect("/");
  } catch (e) {
    next(e);
  }
});

module.exports = router;
