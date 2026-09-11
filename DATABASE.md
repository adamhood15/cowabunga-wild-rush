# Database — Waterpark Leaderboard

Rules for working on this code live in [AGENTS.md](AGENTS.md); game
architecture is in [ARCHITECTURE.md](ARCHITECTURE.md#naming-screen-leaderboard-front-end).
Open items are tracked in [TODOLIST.md](TODOLIST.md#leaderboard--database).

**Status: live, on Railway + Redis.** The leaderboard backend
(`/claim`, `/submit`, `/leaderboard`, `/rank`, `/names`) moved off the
`waterpark-leaderboard` WordPress plugin onto a standalone Node/Express
service (`leaderboard-service/`) deployed to Railway, backed by Railway's
Redis add-on. This closed a real reliability problem: those five routes
used to boot all of WordPress and its full plugin stack (Wordfence, Oxygen,
ACF Pro, WPO365, ws-form-pro, Mailchimp, Action Scheduler, Yoast) on every
hit, which meant a fixed PHP-FPM worker pool would exhaust under
concurrent-player load at launch. See
`/Users/Adam.Hood/.claude/plans/lazy-rolling-matsumoto.md` for the full
migration plan and rationale.

WordPress still hosts `/play/` (`class-game-router.php`, a blank
`template_include` route, no theme/plugin chrome) and the signup-gate
funnel (`/gate-token`, `class-gate.php`, `class-gate-page.php`) — that
surface is low-volume (one hit per player, not per-run) and entangled with
WP page/form infrastructure, so it wasn't worth moving. The old MySQL-backed
classes (`class-database.php`, `class-score-repository.php`,
`class-name-pool.php`, `class-rate-limiter.php`, `class-claim-cleanup.php`,
and the `{wp_prefix}stampede_scores` table they drove) have been deleted
from the plugin now that nothing calls them — `class-rest-controller.php`
only registers `/gate-token`.

## Redis data model (`leaderboard-service/`)

Everything is namespaced `wplb:{game_key}:...` (`buildLeaderboardKeys()` in
`src/keys.js`), where `game_key` is always the service's own
`GAME_KEY` env var (defaults to `waterpark`) — never taken from the client,
same reasoning the old WP controller used: there's no multi-game UI yet, and
accepting an arbitrary `game_key` would let a caller write into namespaces
nothing else uses.

| Key | Type | Purpose |
|---|---|---|
| `wplb:{game}:board` | ZSET, member = `token` | The leaderboard itself. Score is a **composite** value encoding `score DESC, created_at ASC` into one sortable number (see below) — reads use `ZREVRANGE`/`ZCOUNT`. |
| `wplb:{game}:player:{token}` | HASH | `player_name`, `score`, `created_at`, `session_id`. Source of truth for a token's current best; `/submit`'s forward-only guard reads `score` from here. |
| `wplb:{game}:name:{player_name}` | STRING, `SET ... NX` | The atomicity primitive for name uniqueness — replaces the MySQL `idx_game_name` unique constraint + insert-failure retry. A failed `SET NX` is exactly the "lost the race" signal the old `insert_new()` returning false gave. |
| `wplb:{game}:names` | SET | Backs `/names` (`SMEMBERS`) — powers the naming screen's reel-avoidance. |
| `wplb:{game}:unplayed` | ZSET, member = `token`, score = claim timestamp | Tracks reserved-but-never-played claims; `ZREM`'d the instant a real score lands (`submit.lua`). The hourly cleanup sweep (`src/cleanup.js`) scans this, not the whole board. |
| `wplb:rl:{bucket}:{ip}` | STRING (counter) | Fixed-window per-IP rate limiter — `INCR` + `EXPIRE` as one atomic `EVAL` (`scripts/rateLimit.lua`), closing the TOCTOU gap the old WP-transient version's own comment flagged. |

### Composite score encoding

```js
// src/scoring.js
const SCORE_MULTIPLIER = 1e10;
compositeScore = score * SCORE_MULTIPLIER - createdAtSec;
```

A Redis ZSET only sorts on one number, so this composes the schema's real
tie-break — `score DESC, created_at ASC` — into one sortable value:
multiplying `score` by a gap far larger than any real `created_at`
guarantees a higher score always outranks a lower one regardless of timing,
and subtracting `created_at` makes an earlier claim win within the same
score. This is an intentional **approximation** of the original 3-way SQL
tie-break (`score DESC, created_at ASC, id ASC`) — there's no residual
id-level tiebreak for a true same-second collision — acceptable since
scoring is coarse enough that exact same-second ties across two different
players are already rare.

`/rank`'s implementation follows directly from this: every composite value
for a given score tops out at `score * SCORE_MULTIPLIER` (achieved as
`created_at -> 0`), and `SCORE_MULTIPLIER` dwarfs any real unix timestamp —
so a `ZCOUNT` strictly above that threshold is exactly "how many players
have a higher score," the same thing the old `COUNT(*) WHERE score > ?`
counted.

## Storage model — one entry per player, forward-only

Same design as the original MySQL schema, ported rather than changed: one
hash per player (upsert on personal best), not one row per run — this is
still what keeps "your rank" meaningful rather than "#N of every run ever
played," and it's still true that **full per-run history is not retained**;
a run that doesn't beat a player's best leaves no trace. A second, append-
only structure would be needed for per-run analytics.

`submit.lua` enforces the forward-only guard atomically:

```lua
local cur = tonumber(redis.call('HGET', KEYS[1], 'score'))
if cur == nil then return -1 end          -- unclaimed token
if tonumber(ARGV[2]) > cur then           -- only advance on a strictly higher score
  redis.call('HSET', KEYS[1], 'score', ARGV[2], 'created_at', ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])    -- no longer "unplayed"
  return 1
end
return 0
```

This is the same guard the old `ON DUPLICATE KEY UPDATE ... IF(VALUES(score)
> score, ...)` enforced — a resubmitted lower score never overwrites a real
personal best — just expressed as a single atomic `EVAL` instead of a SQL
upsert, so there's no read-then-write race between two concurrent
submissions for the same token.

## Design decisions

- **`token` (not `session_id`) is the identity key.** Generated
  server-side at claim time (`crypto.randomBytes(16).toString("hex")`),
  returned to the client once, stored client-side. No email or PII
  collected. Never treat a client-supplied token as proof of identity
  beyond a lookup — it's a key against an existing hash, never chosen or
  guessed by the client.
- **`session_id` is a per-run diagnostic value**, not identity — stored on
  the player hash but never used for lookup.
- **`player_name` is unique per `game_key`**, enforced by `SET ... NX` on
  the `wplb:{game}:name:{name}` key. Names are drawn from a closed,
  pre-audited word pool (adjective × noun) at claim time, never typed
  freely — see "Word pool" below. A collision is expected and resolved by
  the service appending a random 3-digit suffix and retrying (`claim.lua`'s
  loop, bounded at `MAX_CLAIM_ATTEMPTS = 30`) — never by allowing a
  duplicate. The suffix's own digit blocklist (`BAD_NUM` — `187`, `322`,
  `420`, `451`, `666`, `911`; 3-digit only, since the generator draws
  100–999) lives in `src/namePool.js`.
- **Tie-break ordering:** `score DESC, created_at ASC` via the composite
  ZSET score above — the first player to reach a tied score ranks ahead.
  Scoring is coarse enough that exact ties across many players are
  expected, not rare.
- **Never store scores as anything but integers.** `parseScore()`
  (`src/scoring.js`) rejects anything that isn't already a non-negative
  `Number.isSafeInteger` — no coercion of strings/floats into "the nearest
  plausible score" the way `clampScore()` (used only for `/rank`'s
  query-string input, where a wrong read has no lasting consequence) does.
- **Data is retained indefinitely.** No automatic deletion of a player's
  hash for a *real* score (`score > 0`) — only reserved-but-never-played
  claims are ever cleaned up (see below). Table size (well, key count) is
  bounded by player count, not run count.
- **The hourly cleanup sweep only touches unplayed claims.** `src/cleanup.js`
  scans `wplb:{game}:unplayed` for tokens claimed more than 48 hours ago
  (`GRACE_SECONDS`) and releases them (`releaseUnplayedClaim`, `scripts/cleanup.lua`)
  — freeing the name back into the pool. A real play (`score > 0`) is
  `ZREM`'d out of `:unplayed` the instant `/submit` lands, so it's never a
  candidate no matter how old. `cleanup.lua` re-checks atomically,
  immediately before deleting, that the token is *still* unplayed — closing
  a race where a real submit lands between the sweep's scan and its delete.
- **All Redis access goes through `ioredis`**, with the four multi-step
  operations (claim, submit, cleanup-release, rate-limit increment)
  expressed as `EVAL`'d Lua scripts (`scripts/*.lua`, registered via
  `redis.defineCommand`) rather than separate round trips — this is what
  makes each of them atomic under concurrent requests, not just "usually
  fine."

## Cheat-audit mitigations (ported from the WP-era `class-rest-controller.php`)

Both findings from the 2026-08-28 audit carried over into the Railway
service, same numbers, same reasoning:

- **Score plausibility ceiling** — `/submit` rejects any score above
  `MAX_PLAUSIBLE_SCORE` (100,000) with `422 waterpark_score_implausible`.
  Per `runScore()`'s own ceiling comment in `index.html`: an unsteered bot
  banks ~0.57 coins/sec (measured 2026-08-18), a skilled player roughly 5x
  that, ~28 score/sec — 100,000 is a generous ~1-hour single-sitting cap,
  not a tight bound. This doesn't validate a score is *real*, just rejects
  what no real run could plausibly reach.
- **Per-IP rate limiting** on both `/claim` (30 requests / 10 min) and
  `/submit` (20 requests / 5 min), via `wplb:rl:{bucket}:{ip}` — generous
  enough for a shared park-Wi-Fi NAT (many real players, one IP) while
  bounding a scripted spree. IP comes from Railway's edge
  (`app.set("trust proxy", true)`, same trust assumption
  `class-rate-limiter.php` made about Kinsta's edge, just structurally true
  here rather than merely assumed).
- **Still accepted, not addressed:** anyone can still claim any name that
  isn't currently held (no ownership/identity check beyond the token), and
  a forged score anywhere under the ceiling is still possible with a single
  request — this closes the instant, obviously-fake case and permanent
  squatting, not forgery or squatting in general. Fine for a park promo;
  revisit if the board actually gets gamed.
- **`/leaderboard`, `/rank`, `/names` remain zero-auth, unlimited reads** —
  still fine, they can't alter the board. CORS (`cors({ origin: true })`,
  reflecting the request origin) is what actually scopes who can *call*
  this service at all in a browser context, replacing same-origin WP
  hosting's implicit protection now that the service lives on its own
  Railway domain.

## Front-end integration (`Board`, in `index.html`)

`Board.me()` is local/synchronous (reads the device's own cached rider);
`claim()`, `submit()`, `top(n)`, `rankOf(score)`, `takenNames()` are async,
calling the leaderboard-service's REST routes (`/claim`, `/submit`,
`/leaderboard`, `/rank`, `/names`) — now **cross-origin** (Railway domain),
not same-origin WP REST as before.

- **Naming screen fails open**: if `/names` errors or times out (5s), reels
  paint from an empty taken-set rather than blocking the screen — the game
  must stay playable on a bad network. Every reroll draws locally against
  the fetched taken-set (bounded at 25 attempts); a genuine race between two
  players falls through to `claim()`'s own server-side suffix retry.
- **`submit()` is fire-and-forget** — the results card banks the score
  locally first and never waits on the network. `Board.top()` guards
  against the resulting race (opening the leaderboard before a submit
  lands) by taking `Math.max(server, local)` for the player's own row.
- `namesPromise` is started as early as possible (parallel with sprite
  loading) so the naming screen never shows blank reels — see
  [ARCHITECTURE.md](ARCHITECTURE.md#loading-screen).

**`Board`'s `API` constant** (`index.html`, `const API = ...`) is a
placeholder (`https://REPLACE-WITH-RAILWAY-URL.up.railway.app`) in the
repo's own copy, used for local testing against `python3 server.py`.
`tools/deploy.sh` rewrites it to the real deployed Railway service URL for
the copy that actually ships to WordPress (`STAMPEDE_LEADERBOARD_API` env
var). Because the service is cross-origin by design now, nothing needs
reverting to a relative path before going live — confirm instead that the
Railway service's CORS allowlist covers the real production domain
(`typhoontexas.com`), not just the Kinsta staging origin. Tracked in
[TODOLIST.md](TODOLIST.md#wordpress-hosting--go-live).

## Word pool

`NAME_A` × `NAME_B` = 99 × 100 = 9,900 combinations, mirrored byte-for-byte
into `leaderboard-service/src/namePool.js` (the claim endpoint validates
server-side, never trusts client text — `isValidWord()`). There is still no
build step tying the two copies together — if the reel words or blocklist
change on the client, they must change here too, or a legitimate reel pick
will be rejected as invalid. `NAME_A` is 99, not 100 — see the 2026-08-27
audit below.

**Ruled on by the user (2026-08-18):** the original 40×40 pool was read
word-by-word for tone/trademark/association. Only `Blazin'` was cut
(cannabis-slang read plus letting it stand made a couple of noun pairings
land wrong) and replaced with `Trusty`. Everything else flagged in that
audit was **explicitly kept** — recorded here so it isn't re-litigated:

- `Bellyflop`, `Stallion`, `Sizzlin'` — flagged as body/virility-adjacent in
  some pairings, kept anyway.
- `Riptide`, `Whirlpool`, `Ripcurl` — water-hazard words at a water park,
  kept; on-theme outweighs the association.
- `Longhorn`, `Mustang`, `Bronco`, `Wrangler`, `Ripcurl`, `Whirlpool`,
  `Gator`, `Frosty`, `Maverick` — trademark/brand association, kept as
  non-infringing first-name use. `Longhorn` (UT Athletics, in a Texas park)
  is the one worth a second look if this is ever revisited.
- `Blazin'` *(removed)*, `Sunbaked`, `Drippy`, `Catfish`, `Stormy`,
  `Cowpoke` — minor slang/association readings, kept.

**Ruled on by the user (2026-08-27):** the 60 new adjectives and 60 new
nouns added in the 2026-08-20 expansion, previously only Claude-screened,
got the same word-by-word read the original 80 got. Only `Slippery` was cut
(negative-personality read — sneaky/untrustworthy) and not replaced, so
`NAME_A` is 99 words, not 100. Everything else flagged in that pass was
**explicitly kept** — recorded here so it isn't re-litigated:

- `Wiry`, `Rippling`, `Dripping` — body/virility-adjacent, same category as
  `Stallion`/`Sizzlin'` above, kept anyway.
- `Saddlesore`, `Slick`, `Vulture`, `Buzzard`, `Piranha` — minor
  negative-connotation readings, kept.
- `Gunslinger`, `Sidewinder` — weapon-adjacent, a new category this
  expansion introduced; kept.
- `Saloon`, `Cantina` — alcohol-reference, another new category; kept.
- `Tidalwave` — water-hazard word, same category as `Riptide`/`Whirlpool`
  above, kept.
- `Flipper`, `Stingray`, `Barracuda` — trademark/brand association, same
  category as `Longhorn`/`Mustang` above, kept as non-infringing use.
