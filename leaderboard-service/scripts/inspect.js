// Read-only inspection of the leaderboard Redis data, run via
// `railway run node scripts/inspect.js` so REDIS_URL comes from the
// linked service's own env — never printed, only consumed.
const Redis = require("ioredis");

const gameKey = process.env.GAME_KEY || "waterpark";
const redis = new Redis(process.env.REDIS_URL);

function keys(gameKey) {
  return {
    board: `wplb:${gameKey}:board`,
    names: `wplb:${gameKey}:names`,
    unplayed: `wplb:${gameKey}:unplayed`,
    player: (token) => `wplb:${gameKey}:player:${token}`,
  };
}

async function main() {
  const K = keys(gameKey);

  const boardCount = await redis.zcard(K.board);
  const unplayedCount = await redis.zcard(K.unplayed);
  const namesCount = await redis.scard(K.names);

  console.log(`game_key: ${gameKey}`);
  console.log(`board (claimed+played): ${boardCount}`);
  console.log(`unplayed (reserved, score=0): ${unplayedCount}`);
  console.log(`names taken: ${namesCount}`);
  console.log("");

  const tokens = await redis.zrevrange(K.board, 0, -1);
  console.log(`--- board entries (${tokens.length}) ---`);
  for (const token of tokens) {
    const p = await redis.hgetall(K.player(token));
    console.log(
      `${token}  name=${p.player_name}  score=${p.score}  created_at=${p.created_at}  session_id=${p.session_id}`
    );
  }

  const unplayedTokens = await redis.zrange(K.unplayed, 0, -1, "WITHSCORES");
  console.log("");
  console.log(`--- unplayed claims (${unplayedTokens.length / 2}) ---`);
  for (let i = 0; i < unplayedTokens.length; i += 2) {
    const token = unplayedTokens[i];
    const claimedAt = new Date(Number(unplayedTokens[i + 1]) * 1000).toISOString();
    const p = await redis.hgetall(K.player(token));
    console.log(`${token}  name=${p.player_name}  claimed_at=${claimedAt}`);
  }

  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
