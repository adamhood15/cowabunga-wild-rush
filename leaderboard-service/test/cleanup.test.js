const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanupUnplayedClaims, GRACE_SECONDS } = require("../src/cleanup");
const { FakeRedis } = require("./helpers/fakeRedis");

const GAME_KEY = "waterpark";
const keys = {
  board: `wplb:${GAME_KEY}:board`,
  names: `wplb:${GAME_KEY}:names`,
  unplayed: `wplb:${GAME_KEY}:unplayed`,
  player: (token) => `wplb:${GAME_KEY}:player:${token}`,
  name: (n) => `wplb:${GAME_KEY}:name:${n}`,
};

// Mirrors what claim.lua actually writes on a successful claim, so these
// tests exercise cleanup against realistic state rather than a shortcut.
async function seedClaim(redis, { token, name, claimedAtSec }) {
  await redis.hset(keys.player(token), "player_name", name, "score", "0", "created_at", String(claimedAtSec));
  await redis.sadd(keys.names, name);
  await redis.hset(keys.name(name), "_", "1"); // stand-in for the SET NX name-lock key
  await redis.zadd(keys.unplayed, claimedAtSec, token);
  await redis.zadd(keys.board, 0, token);
}

test("releases a claim past the grace window and frees its name", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "stale", name: "Dusty Buckaroo", claimedAtSec: now - GRACE_SECONDS - 10 });

  const released = await cleanupUnplayedClaims(redis, GAME_KEY);

  assert.equal(released, 1);
  assert.deepEqual(await redis.smembers(keys.names), []);
  assert.deepEqual(await redis.hmget(keys.player("stale"), "player_name"), [null]);
});

test("does not touch a claim still inside the grace window", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "fresh", name: "Rowdy Otter", claimedAtSec: now - 60 });

  const released = await cleanupUnplayedClaims(redis, GAME_KEY);

  assert.equal(released, 0);
  assert.deepEqual(await redis.smembers(keys.names), ["Rowdy Otter"]);
  assert.deepEqual(await redis.hmget(keys.player("fresh"), "player_name"), ["Rowdy Otter"]);
});

test("never touches a claim once it has a real score (removed from the unplayed tracker on submit)", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "played", name: "Zippy Mule", claimedAtSec: now - GRACE_SECONDS - 10 });
  // submit.lua ZREMs the token from the unplayed tracker the moment a real
  // score lands — simulate that directly rather than going through /submit.
  await redis.zrem(keys.unplayed, "played");

  const released = await cleanupUnplayedClaims(redis, GAME_KEY);

  assert.equal(released, 0);
  assert.deepEqual(await redis.smembers(keys.names), ["Zippy Mule"]);
});

// The actual race this fix closes: cleanup's ZRANGEBYSCORE scan finds a
// token stale, but the player submits a legitimate score before cleanup
// gets around to deleting it. Without the atomic re-check inside
// releaseUnplayedClaim, cleanup would delete the player, name reservation
// and leaderboard entry out from under a real, just-submitted score.
test("a submit landing between the stale-token scan and deletion is never undone", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "raced", name: "Feisty Javelina", claimedAtSec: now - GRACE_SECONDS - 10 });

  // Cleanup's scan would have found "raced" here...
  const staleTokens = await redis.zrangebyscore(keys.unplayed, 0, now - GRACE_SECONDS);
  assert.deepEqual(staleTokens, ["raced"]);

  // ...but the player finishes their run and /submit records a real score
  // right after, exactly like submit.lua does: bump the score, drop the
  // unplayed-tracker entry.
  await redis.hset(keys.player("raced"), "score", "150");
  await redis.zrem(keys.unplayed, "raced");

  // Cleanup now tries to delete the token it found stale earlier. The
  // atomic re-check must refuse, since "raced" is no longer in :unplayed.
  const result = await redis.releaseUnplayedClaim(
    keys.unplayed, keys.names, keys.player("raced"), keys.board,
    "raced", `wplb:${GAME_KEY}:name:`
  );

  assert.equal(result, 0);
  assert.deepEqual(await redis.smembers(keys.names), ["Feisty Javelina"]);
  assert.deepEqual(
    await redis.hmget(keys.player("raced"), "player_name", "score"),
    ["Feisty Javelina", "150"]
  );
});

// Second, independent guard: even in the (shouldn't-happen) case where a
// score advanced but the unplayed entry somehow wasn't cleared yet, the
// score-must-still-be-0 check catches it too.
test("also refuses when the stored score is no longer 0, even if still listed as unplayed", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "safety-net", name: "Ornery Coyote", claimedAtSec: now - GRACE_SECONDS - 10 });
  await redis.hset(keys.player("safety-net"), "score", "42");

  const result = await redis.releaseUnplayedClaim(
    keys.unplayed, keys.names, keys.player("safety-net"), keys.board,
    "safety-net", `wplb:${GAME_KEY}:name:`
  );

  assert.equal(result, 0);
  assert.deepEqual(await redis.smembers(keys.names), ["Ornery Coyote"]);
});

test("releases multiple stale claims in one pass and leaves live ones alone", async () => {
  const redis = new FakeRedis();
  const now = Math.floor(Date.now() / 1000);
  await seedClaim(redis, { token: "stale-1", name: "Wild Cactus", claimedAtSec: now - GRACE_SECONDS - 100 });
  await seedClaim(redis, { token: "stale-2", name: "Sunny Rattler", claimedAtSec: now - GRACE_SECONDS - 1 });
  await seedClaim(redis, { token: "fresh-1", name: "Lucky Otter", claimedAtSec: now - 5 });

  const released = await cleanupUnplayedClaims(redis, GAME_KEY);

  assert.equal(released, 2);
  const remainingNames = await redis.smembers(keys.names);
  assert.deepEqual(remainingNames, ["Lucky Otter"]);
});
