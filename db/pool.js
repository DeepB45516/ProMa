// db/pool.js — Postgres connection pool + one-time schema bootstrap.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Hosted Postgres session pools often allow far fewer connections than the
// pg default. Keep this process below that limit; deployments with more
// capacity can opt in to a larger value with PGPOOL_MAX.
const parsedPoolMax = Number.parseInt(process.env.PGPOOL_MAX || "5", 10);
const poolMax = Number.isInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : 5;

if (!process.env.DATABASE_URL) {
  console.error(
    "Missing DATABASE_URL. Set it in your .env file (see .env.example) or in your host's environment variables."
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: process.env.DATABASE_URL.includes("sslmode=disable")
    ? false
    : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err);
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema);
  console.log("Database schema ready.");
}

module.exports = { pool, initSchema };
