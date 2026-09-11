const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const redis = require("./redis");
const { NAME_A, NAME_B, MAX_CLAIM_ATTEMPTS, isValidWord, pickSuffix } = require("./namePool");
const { evaluateRateLimit } = require("./rateLimit");
const { computeCompositeScore, clampScore, parseScore, isPlausibleTimestamp, SCORE_MULTIPLIER } = require("./scoring");
const { cleanupUnplayedClaims } = require("./cleanup");
const { buildLeaderboardKeys } = require("./keys");

const GAME_KEY = process.env.GAME_KEY || "waterpark";
const PORT = process.env.PORT || 3000;

// Cheat-audit finding #1 (2026-08-28, waterpark-leaderboard): /submit took
// any integer with no gameplay validation. Ported as-is from
// class-rest-controller.php — see that file's own comment for the math
// behind the number.
const MAX_PLAUSIBLE_SCORE = 100000;

redis.defineCommand("claimName", {
  numberOfKeys: 5,
  lua: fs.readFileSync(path.join(__dirname, "..", "scripts", "claim.lua"), "utf8"),
});
redis.defineCommand("submitScore", {
  numberOfKeys: 3,
  lua: fs.readFileSync(path.join(__dirname, "..", "scripts", "submit.lua"), "utf8"),
});
redis.defineCommand("releaseUnplayedClaim", {
  numberOfKeys: 4,
  lua: fs.readFileSync(path.join(__dirname, "..", "scripts", "cleanup.lua"), "utf8"),
});
redis.defineCommand("incrementRateLimit", {
  numberOfKeys: 1,
  lua: fs.readFileSync(path.join(__dirname, "..", "scripts", "rateLimit.lua"), "utf8"),
});

const K = buildLeaderboardKeys(GAME_KEY);

// Shared by /claim and /submit, the only two places that generate a
// created_at. Both call this instead of Date.now() directly so a broken
// server clock gets caught here rather than silently writing a
// nonsensical timestamp into Redis. Named for both of its outcomes, not
// just the happy path: it either returns a vetted "now" in seconds, or
// writes the error response itself and returns null — callers just check
// for that and return early (Express 4 doesn't auto-catch a throw from an
// async handler, so this can't just throw instead).
function getPlausibleNowSecOrRespondError(res) {
  const sec = Math.floor(Date.now() / 1000);
  if (!isPlausibleTimestamp(sec)) {
    res.status(500).json({
      code: "waterpark_clock_implausible",
      message: "Server clock looks wrong — refusing to record this.",
    });
    return null;
  }
  return sec;
}

// Every route handler below is async, so a rejected Redis call (a dropped
// connection, a timeout) throws inside a promise Express 4 never awaits —
// it doesn't auto-catch that the way Express 5 does. Left unguarded, that
// rejection goes unhandled process-wide, and Node terminates the entire
// process by default on an unhandled rejection (unless something adds a
// listener) — one transient Redis blip on any route would take the
// service down for every concurrent player, not just the request that
// hit it. Wrapping every handler in this routes any such rejection to the
// error-handling middleware below instead.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const app = express();
// Railway's edge is the only proxy in front of this service, so the
// leftmost X-Forwarded-For entry is the real client IP — same trust
// assumption class-rate-limiter.php made about Kinsta's edge, just true
// here rather than merely assumed.
app.set("trust proxy", true);
app.use(express.json());
// These routes are public/zero-auth by explicit design (see DATABASE.md)
// — reflecting the request origin rather than hardcoding a domain list
// matches the permissive CORS WordPress's REST API already gave this same
// route set, and keeps local phone testing against a live backend
// working without a redeploy.
app.use(cors({ origin: true }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/claim", asyncRoute(async (req, res) => {
  const rateLimit = await evaluateRateLimit(
    redis, "claim", req.ip, 30, 600,
    "Too many name claims from this connection — try again shortly."
  );
  if (!rateLimit.ok) {
    return res.status(rateLimit.status).json({ code: rateLimit.code, message: rateLimit.message });
  }

  const adjective = String(req.body.adjective || "");
  const noun = String(req.body.noun || "");
  const sessionId = req.body.session_id != null ? String(req.body.session_id) : "";

  if (!isValidWord(adjective, NAME_A) || !isValidWord(noun, NAME_B)) {
    return res.status(400).json({
      code: "waterpark_invalid_name",
      message: "Adjective and noun must come from the closed word list.",
    });
  }

  const base = `${adjective} ${noun}`;
  const token = crypto.randomBytes(16).toString("hex");
  const createdAtSec = getPlausibleNowSecOrRespondError(res);
  if (createdAtSec === null) return;
  const initialComposite = computeCompositeScore(0, createdAtSec);

  // First attempt is the bare pair, exactly like the client's own
  // collision loop — a suffix only ever appears after an actual clash.
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base} ${pickSuffix()}`;
    const claimed = await redis.claimName(
      K.name(candidate), K.player(token), K.names, K.board, K.unplayed,
      token, candidate, sessionId, String(createdAtSec), String(initialComposite)
    );
    if (claimed === 1) {
      return res.status(201).json({ token, player_name: candidate, score: 0 });
    }
    // Lost the race (or the name was already taken) — loop again with a
    // fresh suffix rather than erroring.
  }

  return res.status(409).json({
    code: "waterpark_name_pool_exhausted",
    message: "Could not reserve a name for this word pair. Try different words.",
  });
}));

app.post("/submit", asyncRoute(async (req, res) => {
  const rateLimit = await evaluateRateLimit(
    redis, "submit", req.ip, 20, 300,
    "Too many score submissions from this connection — try again shortly."
  );
  if (!rateLimit.ok) {
    return res.status(rateLimit.status).json({ code: rateLimit.code, message: rateLimit.message });
  }

  const token = String(req.body.token || "");
  const score = parseScore(req.body.score);

  // 400: malformed input, e.g. "123xyz", 12.99, a string, or missing
  // entirely. 422 below: correctly formatted, but not a score a single
  // run could plausibly reach — two different classes of "no", so the
  // frontend (and Adam, reading logs) can tell them apart.
  if (score === null) {
    return res.status(400).json({
      code: "waterpark_invalid_score",
      message: "Score must be a non-negative integer.",
    });
  }

  if (score > MAX_PLAUSIBLE_SCORE) {
    return res.status(422).json({
      code: "waterpark_score_implausible",
      message: "Score exceeds what a single run can plausibly reach.",
    });
  }

  const playerKey = K.player(token);
  const createdAtSec = getPlausibleNowSecOrRespondError(res);
  if (createdAtSec === null) return;
  const compositeScore = computeCompositeScore(score, createdAtSec);

  const result = await redis.submitScore(
    playerKey, K.board, K.unplayed,
    token, String(score), String(createdAtSec), String(compositeScore)
  );

  if (result === -1) {
    return res.status(404).json({
      code: "waterpark_unknown_token",
      message: "No claimed name matches this token.",
    });
  }

  // player_name is always the already-claimed name — submit can never
  // rename a player. Re-read post-write, same as the old repository did,
  // so the response reflects the actual current best even when this
  // particular submission didn't advance it.
  const [playerName, currentScore] = await redis.hmget(playerKey, "player_name", "score");
  return res.json({ token, player_name: playerName, score: Number(currentScore) });
}));

app.get("/leaderboard", asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const tokens = await redis.zrevrange(K.board, 0, limit - 1);
  if (tokens.length === 0) return res.json([]);

  const pipeline = redis.pipeline();
  tokens.forEach((token) => pipeline.hmget(K.player(token), "player_name", "score"));
  const results = await pipeline.exec();

  const rows = results.map(([err, [playerName, score]]) => ({
    player_name: playerName,
    score: Number(score || 0),
  }));
  return res.json(rows);
}));

app.get("/rank", asyncRoute(async (req, res) => {
  const score = clampScore(req.query.score);
  // Every composite value for this exact score tops out at score *
  // SCORE_MULTIPLIER (achieved as created_at -> 0); anything strictly
  // above that threshold can only belong to a higher score, since
  // SCORE_MULTIPLIER dwarfs any real unix timestamp. So a ZCOUNT above
  // this threshold is exactly "how many players have a higher score" —
  // the same thing get_player_rank()'s `COUNT(*) WHERE score > ?` counted.
  const threshold = score * SCORE_MULTIPLIER;
  const higher = await redis.zcount(K.board, `(${threshold}`, "+inf");
  return res.json({ rank: higher + 1 });
}));

app.get("/names", asyncRoute(async (req, res) => {
  const names = await redis.smembers(K.names);
  return res.json(names);
}));

// Catches: (a) anything an asyncRoute handler forwarded via next(err) —
// most often a Redis call failing mid-request — and (b) a malformed JSON
// body from express.json(), which otherwise falls through to Express's
// default HTML error page instead of a JSON response an API client can
// parse. Must be declared last and take all four (err, req, res, next)
// arguments — that arity is how Express recognizes error-handling
// middleware.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      code: "waterpark_invalid_json",
      message: "Request body must be valid JSON.",
    });
  }

  console.error(`[${req.method} ${req.path}] unhandled error:`, err.message);
  return res.status(503).json({
    code: "waterpark_temporarily_unavailable",
    message: "Something went wrong on our end — try again shortly.",
  });
});

app.listen(PORT, () => {
  console.log(`leaderboard-service listening on :${PORT} (game_key=${GAME_KEY})`);
});

// Last-resort net for anything outside the request/response lifecycle
// asyncRoute already covers (e.g. a bug in code that isn't a route
// handler). Logs loudly and exits rather than limping on in an unknown
// state — railway.json's restartPolicy brings the service straight back
// up, which is safer than silently swallowing whatever this was.
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandled rejection — exiting so Railway restarts the service:", err);
  process.exit(1);
});

// Hourly claim cleanup — see src/cleanup.js.
cron.schedule("0 * * * *", () => {
  cleanupUnplayedClaims(redis, GAME_KEY).catch((err) => {
    console.error("[cleanup] failed:", err.message);
  });
});

module.exports = app;
