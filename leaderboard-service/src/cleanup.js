// Releases name claims that were reserved but never played, so a
// squatted name recycles back into the pool instead of being lost
// forever. Replaces class-claim-cleanup.php's WP-Cron hourly job — this
// service stays alive as a long-running process, so a scheduled task
// needs no separate cron mechanism the way a stateless function platform
// would. Real rows (score > 0) are never touched, no matter how old — see
// "Data is retained indefinitely" in DATABASE.md.
const { buildLeaderboardKeys } = require("./keys");

const GRACE_SECONDS = 172800; // 48 hours, same grace window as before

// There's a window between this scan and the deletion below where a
// player can legitimately submit — submit.lua ZREMs their token out of
// :unplayed the instant a real score lands, but that can happen after
// this ZRANGEBYSCORE already returned their token as "stale". Deleting
// unconditionally here would race a real submit and destroy a live
// player. releaseUnplayedClaim (scripts/cleanup.lua) re-checks
// atomically, immediately before deleting, that the token is still
// unplayed — so a submit that lands mid-sweep always wins.
async function cleanupUnplayedClaims(redis, gameKey) {
  const K = buildLeaderboardKeys(gameKey);
  const cutoff = Math.floor(Date.now() / 1000) - GRACE_SECONDS;
  const staleTokens = await redis.zrangebyscore(K.unplayed, 0, cutoff);

  let released = 0;
  for (const token of staleTokens) {
    const result = await redis.releaseUnplayedClaim(
      K.unplayed, K.names, K.player(token), K.board,
      token, `wplb:${gameKey}:name:`
    );
    if (result === 1) released++;
  }

  if (released) {
    console.log(`[cleanup] released ${released} unplayed claim(s)`);
  }

  return released;
}

module.exports = { GRACE_SECONDS, cleanupUnplayedClaims };
