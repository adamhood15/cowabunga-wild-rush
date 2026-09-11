// A Redis ZSET only sorts on one number, but the original schema's
// tie-break is score DESC, created_at ASC, id ASC (DATABASE.md). This
// composes score + created_at into one sortable value: multiplying score
// by a gap far larger than any real created_at timestamp guarantees a
// higher score always outranks a lower one regardless of timing, and
// subtracting created_at makes an earlier claim win within the same
// score. This is an intentional approximation of the exact 3-way SQL
// tie-break (no residual id-level tiebreak for a true same-second
// collision), not a byte-for-byte port — acceptable since scoring is
// coarse enough that exact same-second ties are already rare.
const SCORE_MULTIPLIER = 1e10;

function computeCompositeScore(score, createdAtSec) {
  return score * SCORE_MULTIPLIER - createdAtSec;
}

// /rank's score comes from a query string, which is always text and
// where a malformed value has no lasting consequence — worst case is a
// wrong rank for one read. `parseInt(..., 10) || 0` short-circuits NaN to
// 0 *before* Math.max runs, which matters: Math.max(0, NaN) is NaN, not
// 0, so the || has to come first. /submit uses the stricter parseScore
// below instead — a submitted score becomes permanent, publicly-visible
// leaderboard data, so coercing "123xyz" into 123 there would be silently
// accepting malformed input as if it were legitimate.
function clampScore(raw) {
  return Math.max(0, parseInt(raw, 10) || 0);
}

// Unlike clampScore, this never coerces — anything that isn't already a
// non-negative safe-integer number is rejected outright (returns null)
// rather than parsed into "the nearest plausible score". Number.isSafeInteger
// also rejects non-integers (12.99) and values parseInt would otherwise
// silently truncate. typeof raw !== "number" rejects strings/null/undefined
// up front — a JSON body's score field is either a JSON number or it isn't.
function parseScore(raw) {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return null;
  }
  return raw;
}

// created_at is always server-generated (Math.floor(Date.now() / 1000) in
// index.js), never client-supplied — so a timestamp landing in next year
// or later can't be a legitimate submission, only a broken/skewed server
// clock. Computed from the real clock each call rather than a hardcoded
// date, so the ceiling advances on its own every January 1st instead of
// needing a manual bump. `referenceDate` defaults to "now" but is
// injectable so tests aren't tied to the real wall-clock date.
function maxPlausibleTimestampSec(referenceDate = new Date()) {
  const nextYear = referenceDate.getUTCFullYear() + 1;
  return Math.floor(Date.UTC(nextYear, 0, 1) / 1000); // Jan 1 of next year, UTC
}

function isPlausibleTimestamp(createdAtSec, referenceDate = new Date()) {
  return createdAtSec < maxPlausibleTimestampSec(referenceDate);
}

module.exports = {
  SCORE_MULTIPLIER,
  computeCompositeScore,
  clampScore,
  parseScore,
  maxPlausibleTimestampSec,
  isPlausibleTimestamp,
};
