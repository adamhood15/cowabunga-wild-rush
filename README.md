# Cowabunga: Wild Rush — Typhoon Texas

A single-file HTML5 canvas water-slide runner. Steer down an infinite flume,
dodge obstacles, jump waves, and collect Breakers (coins) for as long as you
can survive.

Everything — markup, styling, and game logic — lives in `index.html`
(~2,400 lines). There is no build step and no framework; it's plain Canvas 2D
and vanilla JS.

## Running it

Serve the project over HTTP — don't open `index.html` directly via `file://`,
since audio loading (`fetch` + `decodeAudioData`) silently  falls back to a
degraded path when there's no HTTP origin.

```bash
python3 server.py          # pass a port as the first argument to change it
```

It prints two URLs — one for this machine, one for your phone:

```
Serving /path/to/stampede
  this machine   http://127.0.0.1:8000/
  phone / LAN    http://192.168.1.42:8000/
```

## Testing on a phone

The server binds `0.0.0.0` and sends `Cache-Control: no-store`, so it is
reachable from a phone and won't serve a stale build. To use it:

1. Put the phone on the **same Wi-Fi network** as this machine.
2. Run `python3 server.py` and type the `phone / LAN` URL it prints into the
   phone's browser.

If the phone can't reach it:

- **macOS firewall** — System Settings → Network → Firewall. Either turn it off
  for the session, or allow incoming connections for Python.
- **Wrong network** — a phone on cellular, or on a "guest" Wi-Fi SSID, is not on
  the same network even if it looks like the same router. Check the phone is on
  the identical SSID.
- **Client isolation** — some routers (and most public/corporate Wi-Fi) block
  devices from talking to each other. Use a personal hotspot from the phone and
  connect this machine to it, then re-run the server to get the new address.
- **Address changed** — the LAN IP is assigned by DHCP and can change between
  sessions. Re-read the printed URL rather than reusing a bookmark.

To confirm the phone is genuinely getting fresh bytes, check the request appears
in the server's log output when you reload.

## Controls

| Input | Action |
|---|---|
| `←` / `→` or `A` / `D` | Steer between lanes |
| `↑` / `W` / `Space` | Jump |
| `↓` / `S` | Duck |
| `Esc` / `P` | Pause |
| Swipe left/right | Steer (touch) |
| Swipe up / tap | Jump (touch) |
| Swipe down | Duck (touch) |

## Power-Ups

Rare pickups riding down the flume, separate from the coins and letters.
Each has its own artwork, glow/strobe effect, sound, and card on the
in-game How to Play screen. Every power-up also adds a flat 150 points to
your score the instant you grab it, on top of whatever else it does.

| Power-up | Benefit | Sound |
|---|---|---|
| **Speed Boost** | Surges you past top speed for a few seconds — the same rush a tunnel gives, just something you have to grab. | The existing "Speed Boost 05" effect |
| **Souvenir Bottle** | Instantly banks 100 Breakers, same as if you'd collected them one at a time. Coins spill out of it the whole way up to the HUD, and the Breakers HUD figure flashes yellow when it lands. | Its own sound effect |
| **Extra Life** | Flies up to the HUD and adds a bonus pizza slice to the left of your normal three. It's spent first: the next hit lands like any other (same shake, flash and hurt sound), but instead of costing a real life the bonus slice explodes — only the hit after that costs a life. Only one can ever be held — a second won't spawn until it's used. | Its own sound effect |
| **Whirlpool** | Swirls in the water beneath you for 6 seconds. Any Breaker coin nearby is pulled in and collected automatically — no steering onto it required. Survives a crash; only runs its course or ends when the run does. | Its own sound effect, looped for the whole 6 seconds |
| **Season Pass** | The grand finale — only ever shows up once per run. Grabbing it freezes the action for a 3-second reveal, then resumes into 9 seconds of total invincibility (a hazard hit plays a "that didn't hurt" chime instead of the usual shake/flash/hurt), +75% top speed, and Whirlpool's magnet widened to every collectible on the chute, not just coins. A translucent white-and-gold wash glows across the whole screen for the entire reveal-plus-effect, and Typhoon rides it out in his own animation — hyping up over the pass, settling in for the blissed-out middle stretch, then tossing the card away right as the effect ends. | Its own pickup stinger, then its own music track once the reveal ends and the effect takes over |

## Project structure

```
index.html      All markup, CSS, and game logic (rendering, input, audio, HUD)
server.py       Minimal local HTTP server for development
assets/
  music/        Background and game-over music tracks
  sound-effects/  Jump, collect, hurt/death, and UI sound effects
  sprites/      Rider animation frames (move/jump/duck/hurt/die/spin),
                obstacles (cow, pig, snowman, waves), coins, power-ups,
                and backdrop art
waterpark-leaderboard/  WordPress plugin: /play/ route + signup-gate funnel
                        (game/ and game-assets/ are gitignored, deploy.sh-built)
leaderboard-service/    Leaderboard backend (Node/Express + Redis), deployed
                        to Railway — see DATABASE.md
AGENTS.md       Operating rules; links to ARCHITECTURE.md, DATABASE.md, TODOLIST.md
```

## Architecture notes

For a deep dive into how the renderer, camera, sprite registration, and audio
system work — plus a list of hard-won lessons — see
[`ARCHITECTURE.md`](ARCHITECTURE.md). Open tasks are tracked in
[`TODOLIST.md`](TODOLIST.md), and the leaderboard's database schema is in
[`DATABASE.md`](DATABASE.md). Highlights:

- **Rendering** is a pseudo-3D painter's algorithm on Canvas 2D (no real
  z-buffer): a `project(wx, wy, dz)` function maps world coordinates to screen
  space, and the track itself is generated analytically from sine curves
  rather than baked level data.
- **Audio** has two parallel load paths — Web Audio buffers (primary) and
  `<audio>` elements (fallback for restrictive origins) — both of which need
  testing when audio behavior changes.
- **Sprite registration points** (rider center, tube offsets, hit regions)
  were measured directly off each PNG's alpha channel and must be
  re-measured if a sprite is replaced.

## Leaderboard debugging (Redis on Railway)

`leaderboard-service/scripts/inspect.js` is a read-only dump of every
entry currently on the board — useful for spotting test/junk data before
deciding what to clear. It must run inside Railway's private network
(`redis.railway.internal` doesn't resolve from a local machine), so invoke
it over `railway ssh`, not `railway run`:

```bash
cd leaderboard-service
railway link            # select stampede-wild-rush-leaderboard / production
railway ssh --service leaderboard-service -- node scripts/inspect.js
```

It prints `board`/`unplayed`/`names` counts, then every board entry
(token, name, score, created_at) and every unplayed claim.

To clear test entries, run the same inline delete pattern the script uses
(`redis.zrevrange` the board and `unplayed` zsets for tokens, `del` each
`player:{token}` hash and its `name:{player_name}` reservation key, then
`del` the `board`/`unplayed`/`names` keys themselves) via
`railway ssh --service leaderboard-service -- node -e "..."`. This only
clears entries — the key namespaces aren't a fixed schema, so they're
recreated automatically the next time someone claims a name. See
[DATABASE.md](DATABASE.md#redis-data-model-leaderboard-service) for what
each key holds.

`railway connect Redis` (opens an SSH tunnel + `redis-cli`) is the more
direct route but has intermittently failed with `AUTH failed: WRONGPASS`
even with matching `REDISPASSWORD`/`REDIS_PASSWORD` values and an
up-to-date CLI — `railway ssh` into `leaderboard-service` and running
`node` inline, as above, is the reliable fallback.

## Deployment

This is a static site — pushing to `main` and enabling GitHub Pages (serving
from the repo root) is enough to host it live.
