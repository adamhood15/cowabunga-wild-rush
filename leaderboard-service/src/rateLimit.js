// Fixed-window per-IP rate limiting, replacing class-rate-limiter.php's
// WP-transient version. INCR+EXPIRE run as one atomic EVAL
// (redis.incrementRateLimit, registered from scripts/rateLimit.lua in
// index.js) rather than two separate calls — unlike the old read-then-write
// transient version, whose own comment flagged the TOCTOU gap, two
// concurrent requests can never both observe count === 1 and both
// (re)start the window, and a process death or dropped connection between
// the increment and the expire can never leave a counter permanently
// stuck with no TTL.
//
// Named for both of its effects, not just its return value: it mutates
// the counter for this window AND reports whether the caller is still
// within the limit — a plain "isX"/"allow" name would read as a pure
// check with no side effect, which is misleading here.
async function incrementAndCheckLimit(redis, bucket, ip, maxRequests, windowSeconds) {
  const key = `wplb:rl:${bucket}:${ip}`;
  const count = await redis.incrementRateLimit(key, windowSeconds);
  return count <= maxRequests;
}

// Wraps incrementAndCheckLimit() so a Redis failure (e.g. the connection
// is down) is distinguishable from an exhausted bucket, and returns a
// structured, HTTP-response-shaped result ({ok, status, code, message})
// rather than a boolean — "check" alone would undersell that this also
// catches errors and decides what the frontend should be told. An
// uncaught rejection from incrementAndCheckLimit() would otherwise
// propagate out of an async Express 4 handler with no response ever sent,
// leaving the frontend to time out with no useful information instead of
// getting a real error back.
async function evaluateRateLimit(redis, bucket, ip, maxRequests, windowSeconds, limitedMessage) {
  let allowed;
  try {
    allowed = await incrementAndCheckLimit(redis, bucket, ip, maxRequests, windowSeconds);
  } catch (err) {
    return {
      ok: false,
      status: 503,
      code: "waterpark_rate_limit_unavailable",
      message: "Could not verify request rate right now — try again shortly.",
      cause: err,
    };
  }

  if (!allowed) {
    return { ok: false, status: 429, code: "waterpark_rate_limited", message: limitedMessage };
  }

  return { ok: true };
}

module.exports = { incrementAndCheckLimit, evaluateRateLimit };
