// lib/rateLimit.js — simple in-memory rate limiter for sensitive auth routes
// (login, signup, password reset, OTP send). Keyed by IP + route name so one
// abusive client can't hammer these endpoints, without needing a new
// dependency or shared store. Fine for a single-instance deployment; if the
// app ever runs multiple instances, this would need to move to a shared
// store (e.g. Postgres or Redis) to stay effective.
const buckets = new Map();

function rateLimit(name, maxRequests, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

// Periodically clear old buckets so this Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 60 * 60 * 1000) buckets.delete(key);
  }
}, 60 * 60 * 1000).unref();

module.exports = { rateLimit };
