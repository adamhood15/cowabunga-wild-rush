const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeRedis } = require("./helpers/fakeRedis");

// Exercises redis.submitScore against FakeRedis's mirror of
// scripts/submit.lua — see that file and fakeRedis.js's comment on it for
// why a mirror rather than a real Redis. The behavior under test is the
// forward-only guard: a submitted score only ever wins if it's strictly
// greater than the stored best, and losing leaves score, created_at, and
// the leaderboard composite completely untouched.

const GAME_KEY = "waterpark";
const keys = {
  board: `wplb:${GAME_KEY}:board`,
  unplayed: `wplb:${GAME_KEY}:unplayed`,
  player: (token) => `wplb:${GAME_KEY}:player:${token}`,
};

// Mirrors what claim.lua actually writes on a successful claim.
async function seedClaim(redis, { token, name, score = 0, createdAtSec }) {
  await redis.hset(keys.player(token), "player_name", name, "score", String(score), "created_at", String(createdAtSec));
  await redis.zadd(keys.board, 0, token);
  await redis.zadd(keys.unplayed, createdAtSec, token);
}

test("first submission saves the score", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t1", name: "Dusty Buckaroo", createdAtSec: 1000 });

  const result = await redis.submitScore(keys.player("t1"), keys.board, keys.unplayed, "t1", "10000", "1000", "99990000");

  assert.equal(result, 1);
  assert.deepEqual(await redis.hmget(keys.player("t1"), "score"), ["10000"]);
});

test("a higher second submission replaces the score", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t2", name: "Rowdy Otter", score: 10000, createdAtSec: 1000 });

  const result = await redis.submitScore(keys.player("t2"), keys.board, keys.unplayed, "t2", "15000", "2000", "149990000");

  assert.equal(result, 1);
  assert.deepEqual(await redis.hmget(keys.player("t2"), "score"), ["15000"]);
});

test("a lower second submission does not replace the score", async () => {
  // The exact scenario from the ticket: run #1 scores 10,000 at 1:00pm,
  // run #2 scores 5,000 at 2:00pm. Run #2 must have zero effect.
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t3", name: "Zippy Mule", score: 10000, createdAtSec: 1000 });

  const result = await redis.submitScore(keys.player("t3"), keys.board, keys.unplayed, "t3", "5000", "2000", "49990000");

  assert.equal(result, 0);
  assert.deepEqual(await redis.hmget(keys.player("t3"), "score"), ["10000"]);
});

test("an equal second submission does not replace the score", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t4", name: "Wild Cactus", score: 10000, createdAtSec: 1000 });

  const result = await redis.submitScore(keys.player("t4"), keys.board, keys.unplayed, "t4", "10000", "2000", "99980000");

  assert.equal(result, 0);
  assert.deepEqual(await redis.hmget(keys.player("t4"), "score"), ["10000"]);
});

test("a lower submission does not change the best-score timestamp", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t5", name: "Sunny Rattler", score: 10000, createdAtSec: 1000 });

  await redis.submitScore(keys.player("t5"), keys.board, keys.unplayed, "t5", "5000", "2000", "49990000");

  assert.deepEqual(await redis.hmget(keys.player("t5"), "created_at"), ["1000"]);
});

test("an equal submission does not change the best-score timestamp", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t6", name: "Lucky Otter", score: 10000, createdAtSec: 1000 });

  await redis.submitScore(keys.player("t6"), keys.board, keys.unplayed, "t6", "10000", "2000", "99980000");

  assert.deepEqual(await redis.hmget(keys.player("t6"), "created_at"), ["1000"]);
});

test("a lower submission does not change the leaderboard's ZSET composite", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t7", name: "Feisty Javelina", score: 10000, createdAtSec: 1000 });
  const compositeBefore = 99990000;
  await redis.zadd(keys.board, compositeBefore, "t7");

  const result = await redis.submitScore(keys.player("t7"), keys.board, keys.unplayed, "t7", "5000", "2000", "49990000");

  assert.equal(result, 0);
  const board = redis.zsets.get(keys.board);
  assert.equal(board.get("t7"), compositeBefore, "composite must be untouched by a losing submission");
});

test("an equal submission never touches the composite", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t9", name: "Gritty Roadrunner", score: 10000, createdAtSec: 1000 });
  const compositeBefore = 99990000;
  await redis.zadd(keys.board, compositeBefore, "t9");

  const result = await redis.submitScore(keys.player("t9"), keys.board, keys.unplayed, "t9", "10000", "2000", "99980000");

  assert.equal(result, 0);
  const zsets = redis.zsets.get(keys.board);
  assert.equal(zsets.get("t9"), compositeBefore, "composite must be untouched by a tying submission");
});

test("an unknown token returns -1", async () => {
  const redis = new FakeRedis();

  const result = await redis.submitScore(keys.player("no-such-token"), keys.board, keys.unplayed, "no-such-token", "10000", "1000", "99990000");

  assert.equal(result, -1);
});

test("a successful first submission removes the token from :unplayed", async () => {
  const redis = new FakeRedis();
  await seedClaim(redis, { token: "t10", name: "Plucky Roadrunner", createdAtSec: 1000 });
  assert.ok((await redis.zrangebyscore(keys.unplayed, -Infinity, Infinity)).includes("t10"));

  await redis.submitScore(keys.player("t10"), keys.board, keys.unplayed, "t10", "8680", "2000", "86790000");

  assert.ok(!(await redis.zrangebyscore(keys.unplayed, -Infinity, Infinity)).includes("t10"));
});
