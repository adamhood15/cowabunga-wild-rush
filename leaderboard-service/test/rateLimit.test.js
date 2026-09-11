const test = require("node:test");
const assert = require("node:assert/strict");
const { incrementAndCheckLimit, evaluateRateLimit } = require("../src/rateLimit");
const { FakeRedis } = require("./helpers/fakeRedis");

test("allows requests up to the limit, blocks the one after", async () => {
  const redis = new FakeRedis();
  for (let i = 0; i < 3; i++) {
    assert.equal(await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 3, 600), true);
  }
  assert.equal(await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 3, 600), false);
});

test("different buckets and different IPs are tracked independently", async () => {
  const redis = new FakeRedis();
  assert.equal(await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 1, 600), true);
  assert.equal(await incrementAndCheckLimit(redis, "claim", "5.6.7.8", 1, 600), true); // different IP, same bucket
  assert.equal(await incrementAndCheckLimit(redis, "submit", "1.2.3.4", 1, 600), true); // same IP, different bucket
});

test("expire is only set on the first increment of a window, not every call", async () => {
  const redis = new FakeRedis();
  let expireCalls = 0;
  const originalExpire = redis.expire.bind(redis);
  redis.expire = async (...args) => { expireCalls++; return originalExpire(...args); };

  await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 5, 600);
  await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 5, 600);
  await incrementAndCheckLimit(redis, "claim", "1.2.3.4", 5, 600);

  assert.equal(expireCalls, 1);
});

// The actual bug this fixes: INCR and EXPIRE used to be two separate
// calls, so a process death or dropped connection between them could
// leave a counter with no TTL at all — permanently rate-limiting that IP.
// incrementRateLimit (scripts/rateLimit.lua) runs both as one atomic EVAL
// instead, so a brand-new key is guaranteed to get a TTL in the same
// operation that creates it.
test("a newly created rate-limit key always receives a TTL in the same operation that creates it", async () => {
  const redis = new FakeRedis();
  const expireCalls = [];
  const originalExpire = redis.expire.bind(redis);
  redis.expire = async (...args) => { expireCalls.push(args); return originalExpire(...args); };

  const count = await redis.incrementRateLimit("wplb:rl:claim:1.2.3.4", 600);

  assert.equal(count, 1);
  assert.deepEqual(expireCalls, [["wplb:rl:claim:1.2.3.4", 600]]);
});

test("full window lifecycle: N requests allowed, N+1 blocked, TTL set once and never reset", async () => {
  const redis = new FakeRedis();
  let expireCalls = 0;
  const originalExpire = redis.expire.bind(redis);
  redis.expire = async (...args) => { expireCalls++; return originalExpire(...args); };

  const max = 4;
  for (let i = 1; i <= max; i++) {
    assert.equal(await incrementAndCheckLimit(redis, "claim", "9.9.9.9", max, 600), true, `request ${i} should be allowed`);
  }
  assert.equal(await incrementAndCheckLimit(redis, "claim", "9.9.9.9", max, 600), false, "request N+1 should be blocked");

  assert.equal(expireCalls, 1, "TTL must be set exactly once, on the first request, never reset");
});

test("evaluateRateLimit resolves ok when under the limit", async () => {
  const redis = new FakeRedis();
  const result = await evaluateRateLimit(redis, "claim", "1.2.3.4", 3, 600, "too many claims");
  assert.deepEqual(result, { ok: true });
});

test("evaluateRateLimit returns a 429 with the given message once the bucket is exhausted", async () => {
  const redis = new FakeRedis();
  await evaluateRateLimit(redis, "claim", "1.2.3.4", 1, 600, "too many claims");

  const result = await evaluateRateLimit(redis, "claim", "1.2.3.4", 1, 600, "too many claims");

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "waterpark_rate_limited");
  assert.equal(result.message, "too many claims");
});

// The actual bug this fixes: without this wrapper, a Redis failure inside
// incrementAndCheckLimit() would reject uncaught out of an async Express 4
// handler — no response ever sent, the frontend just times out with no
// information.
test("evaluateRateLimit returns a distinguishable 503 (not a thrown error) when Redis itself fails", async () => {
  const redis = new FakeRedis();
  redis.incr = async () => { throw new Error("connection refused"); };

  const result = await evaluateRateLimit(redis, "claim", "1.2.3.4", 3, 600, "too many claims");

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, "waterpark_rate_limit_unavailable");
  assert.ok(result.cause instanceof Error);
});
