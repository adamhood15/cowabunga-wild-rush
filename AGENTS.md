# AGENTS.md

Operating rules for agents working on **Cowabunga: Wild Rush** (Typhoon Texas —
Buckaroo Run). This file is strict rules only, kept lean — for detail, follow
the links:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the renderer, camera,
  steering, sprites, audio, and power-ups actually work; the tooling setup;
  hard-won lessons.
- **[DATABASE.md](DATABASE.md)** — the leaderboard schema, the WordPress
  plugin, and design decisions behind them.
- **[TODOLIST.md](TODOLIST.md)** — the current open-work queue, blocked
  items, and things the user has explicitly parked.

## How to work

- **Ask rather than assume.** When a request is not explicit, ask a
  follow-up before planning edits — do not fill in the blanks yourself.
- **Measure before coding.** Verify against real assets and real geometry
  before writing anything — the first hypothesis has repeatedly been wrong.
- **Plan before editing anything structural.**
- **Comments explain *why*, never *what*.** No narrating comments.
- **Follow DRY.** Prefer existing patterns over introducing abstractions.
- **Name variables explicitly** — not `t`, name it for what it holds.
- **Always name JavaScript functions and variables so they describe what
  they are or what they do** — not `add`/`wall`/`puff`, not `t`/`i`/`w` as
  parameters, not `$`/`C`/`T` as globals. Applies file-wide, not just to new
  code: when touching a poorly-named identifier, rename it (verify with the
  real page over CDP afterward — a rename can silently break a call site,
  and separately, macOS `sed` does not support `\b`, so a `\bname\b`
  word-boundary rename must go through Node's regex engine or it can
  silently match nothing).
- **Check mobile viewports on every UI change** — screenshot at phone sizes
  before saying it works.
- **Confirm before committing.** The user asks for commits; never commit
  unprompted. Branch first if on `main`.
- **If the token gate is ever taken down for a reason other than
  testing**, remove the `noindex` (`X-Robots-Tag`) on the game route in
  `class-game-router.php` — it exists only to keep the gated URL out of
  search results while a token is required; an intentionally open game
  should be indexable.
- **Report faithfully** — say what you actually verified, and what you
  skipped.
- Run the narrowest relevant test first.
- Do not inspect generated files unless necessary.
- Avoid reading large logs or directories when targeted search works.

### Compaction

When compacting, preserve: current objective, modified file paths,
architectural decisions, unresolved errors, test results, next intended
action.

## The user's setup

- Tests on a **real phone, Android Chrome**. Never explain a mobile bug with
  WebKit/iOS behaviour without checking it applies.
- Run with `python3 server.py` (binds `0.0.0.0`, sends `Cache-Control:
  no-store`). **Never `file://`** — `fetch` fails there and audio silently
  drops to a second code path.
- **A phone will serve a cached page for hours.** Confirm the device
  received fresh bytes before debugging code — "the change isn't working"
  has been a stale cache more than once.

## Verifying your work

- Drive the real page headless over the DevTools protocol — see
  [ARCHITECTURE.md#tooling](ARCHITECTURE.md#tooling) for the setup and
  scripts. **Never use `--window-size`** (headless clamps to a 500px
  minimum and invents overflow that isn't real).
- **Force screens from window globals** (`state`, `start()`, `reset()`,
  `gameOver()`, etc.), not synthetic clicks.
- **Audio unlock bugs need real input events** — `Input.dispatchTouchEvent`
  over CDP, not a JS-dispatched `PointerEvent`.
- **Check `tools/` for an existing script before writing a new one.** Skim
  the filenames and, for anything that looks close, its header comment —
  there are 25+ of these and several already cover adjacent ground (audio
  unlock, naming/rider flow, rank/leaderboard races, power-up visuals,
  viewport audits). Extend or parameterize an existing script over adding a
  near-duplicate; a new file is for a genuinely new thing to verify.
- **Rebuild verification tooling before any nontrivial change, and commit it
  under `tools/`** — never leave it in a session scratchpad. It has
  repeatedly caught things review did not.
- **Every tool's `finally` block must call `await stopChrome(chrome)`**
  (from `tools/cdp.js`) — never `chrome.child.kill()` plus a manual
  `rmSync`, and never a bare `try { chrome.child.kill() } catch {}` with no
  cleanup at all. `stopChrome` kills the whole process tree (Chrome's
  GPU/renderer helpers are macOS-sandboxed children that don't reliably
  share the launcher's process group, so signalling just the launcher PID
  leaves them running) and removes the temp profile.
- **`process.exit()` inside a `try` skips its own `finally` block —** Node
  does not unwind async cleanup for it. Every tool's happy-path result must
  be reported as `process.exitCode = n; return;`, never
  `process.exit(n)`, or the `stopChrome()` call above never runs at all.
  This was the actual root cause the one time orphaned `stampede-cdp-*`
  Chrome Helper processes piled up and pegged the user's CPU (2026-09-11) —
  the cleanup code was correct and simply never executed. `main().catch(e =>
  { ...; process.exit(1); })` at the very bottom of a file is the one
  exception: by then `main()` has already rejected past its own `finally`,
  so there is nothing left to skip.
- Even so, check `ListAgents`/process start times before killing anything
  matching `stampede-cdp-*` by hand, in case another session is still using
  it.
- **Never pass `-f` to `pkill`/`pgrep` more than once, and never use `-f`
  with a short/generic pattern.** Only the *last* `-f` wins — a second `-f`
  silently discards the first pattern entirely — and whatever pattern
  survives is matched as a substring against the **full command line of
  every process on the machine**, not just this project's. On 2026-09-14,
  `pkill -f "^python3 server.py$" -f "cowabunga-wild-rush"` (intended to
  stop one leftover local `server.py`) actually ran as
  `pkill -f "cowabunga-wild-rush"` and crashed the user's VS Code and
  browser by killing unrelated processes that happened to carry the repo
  path in their arguments. Kill a known PID (`kill <pid>` from `ps`/`lsof`,
  or `stopChrome()` for anything CDP-launched) instead of pattern-matching;
  if you must use `pkill -f`, pass exactly one `-f`, anchor the pattern
  (`^...$`), and treat the match as machine-wide, not repo-scoped. Also
  remember `-n` on `pkill`/`pgrep` means "newest match only" — it is not a
  dry run, and does not make the signal any safer.
- **Distrust your own tools before you distrust the code.** Calibrate a
  metric against a known-good case before trusting its verdict.

## Tools

Every script here is CDP-based (see `cdp.js`) and follows the conventions
above. Kept intentionally short — condensed 2026-09-11 from 32 scripts down
to these by merging same-subsystem checks and cutting ones that only ever
demonstrated a single already-fixed bug. Reuse or extend one of these before
writing a new one.

- [`cdp.js`](tools/cdp.js) — the shared headless-Chrome/DevTools-Protocol
  client (`launchChrome`, `openPage`, `evaluate`, `stopChrome`, `VIEWPORTS`)
  every other script below builds on.
- [`screenshot.js`](tools/screenshot.js) — screenshots any screen at any
  viewport and probes for overflow/collisions.
- [`viewport-audit.js`](tools/viewport-audit.js) — walks every screen at
  every known-good viewport width with worst-case content, reporting
  horizontal overflow.
- [`sprite-size-audit.js`](tools/sprite-size-audit.js) — checks that rider
  animation frames, power-up icons, and collectible letters each render at a
  consistent VISUAL size (actual opaque-pixel footprint, not raw PNG
  dimensions).
- [`season-pass-measure.js`](tools/season-pass-measure.js) — measures a
  sprite set's tube-registration constants off its real PNG alpha/color
  data; adapt it for the next animated sprite set needing the same treatment
  rather than re-deriving the approach.
- [`load-test.js`](tools/load-test.js) — a safe, rate-limit-aware capacity
  check against the leaderboard-service REST routes (staging only).
- [`gate-check.js`](tools/gate-check.js) — verifies the deployed WP-hosted
  gate/blank-template route after a `deploy.sh` run.
- [`gate-flow-check.js`](tools/gate-flow-check.js) — verifies the landing
  page's signup-form wiring and its submit → success → redirect-to-game flow
  on the live page, without touching the real Mailchimp list.
- [`mailchimp-form-check.js`](tools/mailchimp-form-check.js) — verifies the
  signup form's per-field validation, busy-spinner state, and SMS→E.164
  formatting/JSONP handling.
- [`naming-flow-check.js`](tools/naming-flow-check.js) — verifies the
  naming/rider-claim screen shows once per session and never reopens itself,
  including via the audio-unlock gate.
- [`rank-check.js`](tools/rank-check.js) — verifies the rank/leaderboard
  subsystem: retry-on-network-failure, race-ordering between overlapping
  lookups, and the opt-in `[rank]` debug logging.
- [`extralife-check.js`](tools/extralife-check.js) — verifies the Extra Life
  power-up end to end (pickup, eating flourish, HUD flight, absorbing a hit,
  spawn exclusivity).
- [`whirlpool-check.js`](tools/whirlpool-check.js) — verifies the Whirlpool
  power-up end to end, including its audio loop-trim fix.
- [`seasonpass-check.js`](tools/seasonpass-check.js) — verifies Season
  Pass's two-phase timing (frozen reveal, then the real effect).
- [`speedboost-check.js`](tools/speedboost-check.js) — verifies the
  speed-boost rider animation across both of its triggers.
- [`idle-check.js`](tools/idle-check.js) — verifies the idle rider animation
  is the lowest-priority pose, pre-empted by everything else.
- [`invuln-flash-check.js`](tools/invuln-flash-check.js) — verifies the
  rider's invulnerability flash fires in every window a hit can't land, and
  never otherwise.
- [`collect-fade-check.js`](tools/collect-fade-check.js) — verifies the
  STAMPEDE-letters collect fade plays out over LIVE gameplay (no freeze),
  with WIN_INVULN covering the rider through it.
- [`powerup-score-bonus-check.js`](tools/powerup-score-bonus-check.js) —
  verifies every power-up pickup adds the shared score bonus on top of its
  own effect.
- [`pig-after-wave-gap-check.js`](tools/pig-after-wave-gap-check.js) —
  verifies a pig can never spawn too close behind a wave for a jumping rider
  to survive.
- [`perf-hud-check.js`](tools/perf-hud-check.js) — verifies the opt-in
  perf-debug HUD renders only when armed and reports sane numbers.
- [`cowabunga-popup-check.js`](tools/cowabunga-popup-check.js) — verifies the
  promo popup's timing, focus trap, dismissal, and once-per-day suppression.
- [`deploy.sh`](tools/deploy.sh) — deploys the plugin + a WordPress-ready
  copy of the game to Kinsta staging or production.
- [`compress-assets.sh`](tools/compress-assets.sh) — compresses image/audio
  assets in place; re-run after adding new art or sound.

## Touching assets

- **Back up before any destructive asset operation, and check git state
  first.** Modified-but-uncommitted is not recoverable by `git checkout` —
  copy to a directory outside the repo with a checksum manifest.
- **Never apply one blanket policy to all art.** Sprites that feed measured
  registration constants need a stricter bar than plain-blit backdrops.
- **Verify what you actually changed** by hashing against the backup — the
  user edits files mid-session; don't claim a saving that was theirs.
- Re-read state rather than trusting a `git status` from earlier in the
  conversation — audio and art are frequently re-exported by the user
  mid-session.

## Power-ups

Standing checklist — run every new power-up against all ten before building:

1. Total of 4–5 power-ups in the game, no more.
2. Should feel fun/exciting to get.
3. Should not spawn too often — not constant loot.
4. Should not spawn too rarely — not a scavenger hunt.
5. Each needs its own differentiating glow/strobe/animation effect — not the
   same effect recolored.
6. Each provides some benefit to the character.
7. When active, the player must get a clear on-screen visual cue that it's
   active, and which power-up it is — not just "something is boosted."
8. Every power-up gets its own card on the How to Play screen with a brief
   benefit description.
9. Every power-up needs its own unique sound effect on pickup.
10. Document each power-up in the README as it's added.

All 5 of the 4–5 total are now built, `Season Pass` (added 2026-08-24) being
the last — no slots remain; a new power-up idea needs the cap itself
(re)negotiated with the user first. Mechanics of what's built, and the shared
spawn-clock rule behind rule 3, are in
[ARCHITECTURE.md#power-ups](ARCHITECTURE.md#power-ups).

## Don't re-raise

Items the user has explicitly parked or declined, and open/blocked work, are
tracked in [TODOLIST.md](TODOLIST.md) — check there before proposing work on
lane width, cow/snowman rail clipping, the 80° plunge set-piece, or anything
else that reads like it may have already been decided.
