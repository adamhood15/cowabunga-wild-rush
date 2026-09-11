// Minimal in-memory stand-in for the subset of ioredis's API the pure
// modules (rateLimit.js, cleanup.js) actually call, plus hand-written
// mirrors of the defineCommand'd Lua scripts (submitScore,
// releaseUnplayedClaim, incrementRateLimit — each kept in lockstep with
// its scripts/*.lua field-for-field) so their exact forward-only/atomic
// behavior is unit-testable without a real Redis (EVAL isn't
// reimplemented generically here). /claim's claimName isn't mirrored —
// its correctness is the SET NX race itself, which needs real concurrent
// Redis clients to exercise meaningfully; that's covered by manual
// verification against Railway/local Redis instead.
class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.hashes = new Map();
    this.sets = new Map();
    this.zsets = new Map();
  }

  async incr(key) {
    const next = (Number(this.strings.get(key)) || 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async expire(_key, _seconds) {
    return 1; // TTL isn't modeled — tests only assert *whether* expire was called
  }

  // Mirrors scripts/rateLimit.lua (the real command is registered via
  // redis.defineCommand in index.js, run as a single atomic EVAL).
  // Delegates to this.incr/this.expire — through `this`, not the module
  // bindings — so a test that overrides redis.expire still observes calls
  // made from in here, same as it would against the real Lua script.
  async incrementRateLimit(key, windowSeconds) {
    const count = await this.incr(key);
    if (count === 1) {
      await this.expire(key, windowSeconds);
    }
    return count;
  }

  async hset(key, ...kv) {
    const h = this.hashes.get(key) || new Map();
    for (let i = 0; i < kv.length; i += 2) h.set(kv[i], String(kv[i + 1]));
    this.hashes.set(key, h);
    return 1;
  }

  async hmget(key, ...fields) {
    const h = this.hashes.get(key);
    return fields.map((f) => (h && h.has(f) ? h.get(f) : null));
  }

  async sadd(key, member) {
    const s = this.sets.get(key) || new Set();
    s.add(member);
    this.sets.set(key, s);
    return 1;
  }

  async srem(key, member) {
    const s = this.sets.get(key);
    if (s) s.delete(member);
    return 1;
  }

  async smembers(key) {
    return Array.from(this.sets.get(key) || []);
  }

  async zadd(key, score, member) {
    const z = this.zsets.get(key) || new Map();
    z.set(member, Number(score));
    this.zsets.set(key, z);
    return 1;
  }

  async zrem(key, member) {
    const z = this.zsets.get(key);
    if (z) z.delete(member);
    return 1;
  }

  async zrangebyscore(key, min, max) {
    const z = this.zsets.get(key) || new Map();
    return Array.from(z.entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async del(key) {
    this.hashes.delete(key);
    this.strings.delete(key);
    return 1;
  }

  // Mirrors scripts/submit.lua field-for-field (the real command is
  // registered via redis.defineCommand in index.js, run as a single
  // atomic EVAL). Only ever moves score/created_at/composite forward —
  // a submitted score that isn't strictly greater than the stored best is
  // a no-op, exactly like the Lua's `tonumber(ARGV[2]) > cur` guard.
  async submitScore(playerKey, boardKey, unplayedKey, token, score, createdAtSec, composite) {
    const player = this.hashes.get(playerKey);
    const curRaw = player ? player.get("score") : undefined;
    if (curRaw === undefined) return -1;

    if (Number(score) > Number(curRaw)) {
      player.set("score", String(score));
      player.set("created_at", String(createdAtSec));
      const board = this.zsets.get(boardKey) || new Map();
      board.set(token, Number(composite));
      this.zsets.set(boardKey, board);
      const unplayed = this.zsets.get(unplayedKey);
      if (unplayed) unplayed.delete(token);
      return 1;
    }
    return 0;
  }

  // Mirrors scripts/cleanup.lua field-for-field (the real command is
  // registered via redis.defineCommand in index.js, run as a single
  // atomic EVAL). Re-checks both guards immediately before deleting
  // anything, exactly like the Lua does, so tests can exercise the race
  // this exists to close: a submit landing between cleanup's stale-token
  // scan and this deletion must always win.
  async releaseUnplayedClaim(unplayedKey, namesKey, playerKey, boardKey, token, namePrefix) {
    const unplayed = this.zsets.get(unplayedKey);
    if (!unplayed || !unplayed.has(token)) return 0;

    const player = this.hashes.get(playerKey);
    const score = player ? player.get("score") : undefined;
    if (score !== "0") return 0;

    const playerName = player ? player.get("player_name") : undefined;
    if (playerName) {
      const names = this.sets.get(namesKey);
      if (names) names.delete(playerName);
      this.hashes.delete(`${namePrefix}${playerName}`);
      this.strings.delete(`${namePrefix}${playerName}`);
    }
    this.hashes.delete(playerKey);
    const board = this.zsets.get(boardKey);
    if (board) board.delete(token);
    unplayed.delete(token);
    return 1;
  }

  // ioredis's pipeline returns a chainable builder whose exec() runs the
  // queued commands and resolves an array of [err, result] pairs — mirror
  // just enough of that shape for cleanup.js's usage.
  pipeline() {
    const ops = [];
    const self = this;
    const builder = {
      srem(key, member) { ops.push(["srem", key, member]); return builder; },
      del(key) { ops.push(["del", key]); return builder; },
      zrem(key, member) { ops.push(["zrem", key, member]); return builder; },
      async exec() {
        const results = [];
        for (const [cmd, ...args] of ops) {
          results.push([null, await self[cmd](...args)]);
        }
        return results;
      },
    };
    return builder;
  }
}

module.exports = { FakeRedis };
