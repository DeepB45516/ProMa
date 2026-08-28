#!/usr/bin/env node
// scripts/uptimeBot.js — Standalone Uptime & Health Check Robot
// Usage: node scripts/uptimeBot.js [TARGET_URL] [INTERVAL_MINUTES]
// Example: node scripts/uptimeBot.js https://my-proma-app.onrender.com 5

require("dotenv").config();
const { pingHealthEndpoint } = require("../lib/uptimeRobot");

const defaultUrl = process.env.APP_URL 
  ? `${process.env.APP_URL.replace(/\/$/, "")}/health`
  : `http://localhost:${process.env.PORT || 3000}/health`;

const targetUrl = process.argv[2] || defaultUrl;
const intervalMinutes = parseFloat(process.argv[3]) || 5;

console.log("==================================================");
console.log(" 🤖 ProMa UptimeRobot — Lightweight Health Monitor");
console.log("==================================================");
console.log(` Target Endpoint:   ${targetUrl}`);
console.log(` Check Cadence:     Every 5-7 minutes (Jittered: ${intervalMinutes}m avg)`);
console.log(` Server Load:       Zero DB load, < 1ms response`);
console.log("==================================================\n");

let checkCount = 0;
let successCount = 0;

function getJitteredDelayMs(baseMinutes) {
  // Random jitter between 5 and 7 minutes (or +- 1 minute around specified interval)
  const minMs = Math.max(1, baseMinutes - 1) * 60 * 1000;
  const maxMs = (baseMinutes + 1) * 60 * 1000;
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

async function performHealthCheck() {
  checkCount++;
  const timestamp = new Date().toLocaleTimeString();
  process.stdout.write(`[${timestamp}] [#${checkCount}] Checking ${targetUrl}... `);

  const result = await pingHealthEndpoint(targetUrl);

  if (result.ok) {
    successCount++;
    const uptimePct = ((successCount / checkCount) * 100).toFixed(1);
    console.log(`✅ OK (${result.statusCode}) - Latency: ${result.latency}ms | Uptime: ${uptimePct}%`);
  } else {
    console.log(`❌ FAILED (${result.error || `HTTP ${result.statusCode}`}) - Latency: ${result.latency}ms`);
  }

  const nextDelayMs = getJitteredDelayMs(intervalMinutes);
  const nextCheckTime = new Date(Date.now() + nextDelayMs).toLocaleTimeString();
  console.log(`⏳ Next automated health probe at ${nextCheckTime} (~${Math.round(nextDelayMs / 60000)}m)\n`);

  setTimeout(performHealthCheck, nextDelayMs);
}

// Perform first check immediately on launch
performHealthCheck();

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[UptimeRobot] Stopped.");
  process.exit(0);
});
