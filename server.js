// server.js — ProMa: startup project manager with auth + multi-team support
require("dotenv").config();

const dns = require("dns");
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const path = require("path");

const { initSchema } = require("./db/pool");
const { attachUser } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");
const teamsRoutes = require("./routes/teams");
const tasksRoutes = require("./routes/tasks");
const dashboardRoutes = require("./routes/dashboard");
const notificationsRoutes = require("./routes/notifications");
const remindersRoutes = require("./routes/reminders");
const { processTaskReminders } = require("./lib/reminders");
const { getHealthStatus, startUptimeHeartbeat } = require("./lib/uptimeRobot");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit behind a reverse proxy — trust the first hop so
// req.secure / req.ip and the "secure" cookie flag behave correctly.
app.set("trust proxy", 1);

// Gzip/br-compress API responses and static assets for noticeably faster
// loads, especially on slower mobile connections.
app.use(compression());

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    },
  })
);

// Zero-load health endpoints for UptimeRobot, Render, and external uptime monitors.
// Intentionally does NOT touch the database, run auth, or call any
// external API — it responds in < 1ms with 0 database load.
// Mounted before attachUser so it never depends on session/DB state.
app.all(["/health", "/ping"], (req, res) => {
  if (req.method === "HEAD") {
    return res.status(200).end();
  }
  res.status(200).json(getHealthStatus());
});

app.use(attachUser);

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/teams", teamsRoutes);
app.use("/api/teams/:teamId/tasks", tasksRoutes);
app.use("/api/teams/:teamId/dashboard", dashboardRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/internal", remindersRoutes);

app.get("/api/health", (req, res) => res.json(getHealthStatus()));

// API 404 handler — unmatched /api calls return clean JSON error instead of HTML
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

// SPA fallback for any non-API route.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Centralized error handler — keeps error shapes consistent for the frontend.
app.use((err, req, res, next) => {
  console.error("Server Error:", err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message =
    status === 500 && process.env.NODE_ENV !== "development"
      ? "Something went wrong on our end. Please try again."
      : err.message || "Something went wrong on our end. Please try again.";
  res.status(status).json({ error: message, code: err.code || "SERVER_ERROR" });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ProMa running on http://localhost:${PORT}`);
      // Run once shortly after boot (rather than only after the first
      // 15-minute interval elapses) so a fresh deploy/restart doesn't leave
      // due/overdue reminders unchecked for up to 15 minutes, then continue
      // on a steady 15-minute cadence in the background.
      setTimeout(async () => {
        try {
          await processTaskReminders();
        } catch (e) {
          console.warn("Background reminder processor error:", e.message);
        }
      }, 10 * 1000);

      // Start automated UptimeRobot zero-load health check heartbeat (every 5-7 minutes)
      // Keeps free cloud tiers responsive with near-zero resource consumption.
      if (process.env.ENABLE_UPTIME_HEARTBEAT !== "false") {
        startUptimeHeartbeat({ port: PORT, minMinutes: 5, maxMinutes: 7 });
      }

      setInterval(async () => {
        try {
          await processTaskReminders();
        } catch (e) {
          console.warn("Background reminder processor error:", e.message);
        }
      }, 15 * 60 * 1000);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
