const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeCompositeScore,
  clampScore,
  parseScore,
  maxPlausibleTimestampSec,
  isPlausibleTimestamp,
  SCORE_MULTIPLIER,
} = require("../src/scoring");

test("a higher score always outranks a lower score regardless of timing", () => {
  const lowScoreVeryEarly = computeCompositeScore(100, 1); // best possible composite for score 100
  const highScoreVeryLate = computeCompositeScore(101, 4102444800); // worst possible for score 101 (~year 2100)
  assert.ok(highScoreVeryLate > lowScoreVeryEarly);
});

test("within the same score, an earlier created_at ranks higher (larger composite)", () => {
  const earlier = computeCompositeScore(500, 1000);
  const later = computeCompositeScore(500, 2000);
  assert.ok(earlier > later);
});

test("SCORE_MULTIPLIER dwarfs any realistic unix timestamp", () => {
  const farFutureUnixSeconds = 4102444800; // year 2100
  assert.ok(SCORE_MULTIPLIER > farFutureUnixSeconds);
});

// This is the exact invariant /rank's ZCOUNT threshold in src/index.js
// relies on: `score * SCORE_MULTIPLIER` must sit strictly between the max
// composite a given score can produce and the min composite the next
// score up can produce, for any realistic created_at.
test("rank threshold: score*SCORE_MULTIPLIER separates a score from the one above it", () => {
  const q = 500;
  const threshold = q * SCORE_MULTIPLIER;
  const farFutureUnixSeconds = 4102444800;

  // Even with the most favorable (smallest) created_at, score q must not
  // exceed the threshold...
  assert.ok(computeCompositeScore(q, 1) <= threshold);
  // ...and even with the least favorable (largest realistic) created_at,
  // score q+1 must still exceed it.
  assert.ok(computeCompositeScore(q + 1, farFutureUnixSeconds) > threshold);
});

test("clampScore floors negative input at 0, matching the old BIGINT UNSIGNED schema", () => {
  assert.equal(clampScore(-500), 0);
  assert.equal(clampScore("-1"), 0);
  assert.equal(clampScore(-0.9), 0); // parseInt truncates toward 0, still non-positive
});

test("clampScore treats non-numeric/missing input as 0, not NaN", () => {
  // Math.max(0, NaN) is NaN, not 0 — clampScore must short-circuit before
  // that, not just delegate straight to Math.max.
  assert.equal(clampScore(undefined), 0);
  assert.equal(clampScore(null), 0);
  assert.equal(clampScore("not a number"), 0);
  assert.equal(Number.isNaN(clampScore("not a number")), false);
});

test("clampScore passes real positive scores through, truncating decimals", () => {
  assert.equal(clampScore(8680), 8680);
  assert.equal(clampScore("8680"), 8680);
  assert.equal(clampScore(42.9), 42);
});

test("computeCompositeScore() stays correctly ordered even if a negative score reached it", () => {
  // clampScore is what actually prevents this at the API boundary — this
  // just confirms the math itself doesn't silently misorder a negative
  // score above a real one if that boundary were ever bypassed.
  const negativeScore = computeCompositeScore(-50, 1700000000);
  const zeroScore = computeCompositeScore(0, 1700000000);
  const realScore = computeCompositeScore(1, 1700000000);
  assert.ok(negativeScore < zeroScore);
  assert.ok(zeroScore < realScore);
});

test("parseScore accepts only a non-negative safe-integer number, passing it through unchanged", () => {
  assert.equal(parseScore(0), 0);
  assert.equal(parseScore(8680), 8680);
  assert.equal(parseScore(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

// Unlike clampScore, none of these are coerced into "the nearest
// plausible score" — they're rejected outright as malformed input.
test("parseScore rejects everything clampScore used to silently coerce", () => {
  assert.equal(parseScore("123xyz"), null); // clampScore would have returned 123
  assert.equal(parseScore("1e6"), null); // clampScore would have returned 1
  assert.equal(parseScore(12.99), null); // clampScore would have returned 12
  assert.equal(parseScore("hello"), null); // clampScore would have returned 0
  assert.equal(parseScore(null), null);
  assert.equal(parseScore(undefined), null);
});

test("parseScore rejects negative numbers, non-finite numbers, and non-integers", () => {
  assert.equal(parseScore(-1), null);
  assert.equal(parseScore(-0.5), null);
  assert.equal(parseScore(NaN), null);
  assert.equal(parseScore(Infinity), null);
  assert.equal(parseScore(3.5), null);
  assert.equal(parseScore(Number.MAX_SAFE_INTEGER + 1), null); // no longer a safe integer
});

test("maxPlausibleTimestampSec is Jan 1 of next year, UTC — not a hardcoded date", () => {
  const asOf2026 = new Date("2026-06-15T12:00:00Z");
  assert.equal(maxPlausibleTimestampSec(asOf2026), Date.UTC(2027, 0, 1) / 1000);

  // Advancing the reference year advances the boundary with it — nothing
  // here needs a manual bump when the calendar rolls over.
  const asOf2031 = new Date("2031-01-01T00:00:00Z");
  assert.equal(maxPlausibleTimestampSec(asOf2031), Date.UTC(2032, 0, 1) / 1000);
});

test("isPlausibleTimestamp accepts anything through the end of this year, rejects next year on", () => {
  const referenceDate = new Date("2026-06-15T12:00:00Z");
  const endOfThisYear = Date.UTC(2027, 0, 1) / 1000 - 1;
  const startOfNextYear = Date.UTC(2027, 0, 1) / 1000;

  assert.equal(isPlausibleTimestamp(0, referenceDate), true);
  assert.equal(isPlausibleTimestamp(Math.floor(referenceDate.getTime() / 1000), referenceDate), true);
  assert.equal(isPlausibleTimestamp(endOfThisYear, referenceDate), true);
  assert.equal(isPlausibleTimestamp(startOfNextYear, referenceDate), false);
  assert.equal(isPlausibleTimestamp(startOfNextYear + 10000000, referenceDate), false);
});
