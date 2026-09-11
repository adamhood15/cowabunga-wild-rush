// The Redis key namespace for one game's leaderboard. Shared by index.js
// (routes) and cleanup.js (the hourly sweep) — previously each defined
// its own copy of this under a different name (keysFor / makeKeys), which
// is exactly the kind of drift DRY exists to prevent.
function buildLeaderboardKeys(gameKey) {
  return {
    board: `wplb:${gameKey}:board`,
    names: `wplb:${gameKey}:names`,
    unplayed: `wplb:${gameKey}:unplayed`,
    player: (token) => `wplb:${gameKey}:player:${token}`,
    name: (n) => `wplb:${gameKey}:name:${n}`,
  };
}

module.exports = { buildLeaderboardKeys };
