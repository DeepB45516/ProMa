// lib/uptimeRobot.js — Ultra-lightweight zero-load uptime monitor and health check service
const http = require("http");
const https = require("https");

let heartbeatTimer = null;
let lastPingTime = null;
let lastPingLatencyMs = null;
let lastPingStatus = "initialized";

/**
 * Returns clean, instant health status with near-zero overhead (< 1ms).
 * Intentionally avoids database queries or session lookups.
 */
function getHealthStatus() {
  const memory = process.memoryUsage();
  return {
    status: "ok",
    service: "proma-app",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rssMb: Math.round(memory.rss / (1024 * 1024)),
      heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
    },
    heartbeat: {
      lastCheck: lastPingTime ? lastPingTime.toISOString() : null,
      lastLatencyMs: lastPingLatencyMs,
      lastStatus: lastPingStatus,
    },
  };
}

/**
 * Executes a single zero-load health check request against a target URL.
 * Uses HTTP HEAD / GET with a strict 5-second timeout and minimal buffer.
 */
function pingHealthEndpoint(targetUrl) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const url = new URL(targetUrl);
      const isHttps = url.protocol === "https:";
      const client = isHttps ? https : http;

      const req = client.request(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": "ProMa-UptimeRobot/1.0 (HealthCheck; +https://proma.app)",
            Accept: "application/json, text/plain",
            Connection: "close",
          },
          timeout: 5000,
        },
        (res) => {
          // Consume and discard response stream immediately to release sockets
          res.resume();
          const latency = Date.now() - startTime;
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          resolve({ ok, statusCode: res.statusCode, latency });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "TIMEOUT", latency: Date.now() - startTime });
      });

      req.on("error", (err) => {
        resolve({ ok: false, error: err.message, latency: Date.now() - startTime });
      });

      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message, latency: Date.now() - startTime });
    }
  });
}

/**
 * Starts the internal automated UptimeRobot heartbeat.
 * Pings every 5 to 7 minutes with natural jitter to prevent burst load
 * and keep free cloud instances (Render, Railway, etc.) responsive.
 */
function startUptimeHeartbeat(options = {}) {
  const port = options.port || process.env.PORT || 3000;
  const targetUrl = options.targetUrl || process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, "")}/health` : `http://localhost:${port}/health`;
  const minMinutes = options.minMinutes || 5;
  const maxMinutes = options.maxMinutes || 7;

  // Calculate random interval between minMinutes (e.g. 5m) and maxMinutes (e.g. 7m)
  function getNextIntervalMs() {
    const minMs = minMinutes * 60 * 1000;
    const maxMs = maxMinutes * 60 * 1000;
    return Math.floor(minMs + Math.random() * (maxMs - minMs));
  }

  async function runHeartbeat() {
    const result = await pingHealthEndpoint(targetUrl);
    lastPingTime = new Date();
    lastPingLatencyMs = result.latency;

    if (result.ok) {
      lastPingStatus = "healthy";
      if (process.env.DEBUG_UPTIME === "true" || process.env.NODE_ENV !== "production") {
        console.log(`[UptimeRobot] Heartbeat OK: ${targetUrl} (Status ${result.statusCode}, ${result.latency}ms)`);
      }
    } else {
      lastPingStatus = `failing: ${result.error || result.statusCode}`;
      console.warn(`[UptimeRobot] Heartbeat warning: ${targetUrl} (${result.error || `HTTP ${result.statusCode}`})`);
    }

    const nextDelay = getNextIntervalMs();
    heartbeatTimer = setTimeout(runHeartbeat, nextDelay);
  }

  // Initial ping after 30 seconds of boot
  const initialDelay = 30 * 1000;
  heartbeatTimer = setTimeout(runHeartbeat, initialDelay);

  console.log(`[UptimeRobot] Automated health check scheduled every ${minMinutes}-${maxMinutes} minutes for ${targetUrl}`);

  return {
    stop: () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    },
  };
}

module.exports = {
  getHealthStatus,
  pingHealthEndpoint,
  startUptimeHeartbeat,
};
