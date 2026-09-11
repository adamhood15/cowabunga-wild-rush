#!/usr/bin/env bash
# Deploys the plugin + a WordPress-ready copy of the game to Kinsta, over
# the `typhoontexasnew-staging` or `typhoontexasnew-production` SSH alias
# (see AGENTS.md / ~/.ssh/config on this machine). Target defaults to
# staging — pass "production" as the first argument to deploy live.
#
# The leaderboard API now lives on Railway (leaderboard-service/), not
# WordPress — see /Users/Adam.Hood/.claude/plans/lazy-rolling-matsumoto.md
# for the migration this rewrite is part of. index.html's asset references
# still assume same-path WP hosting (see DATABASE.md#front-end-integration)
# but the Board API constant is now cross-origin by design. This script
# never edits the repo's index.html itself, only a generated copy under
# waterpark-leaderboard/game/ (gitignored, rebuilt every run):
#   - "assets/...                        -> "/wp-content/plugins/waterpark-leaderboard/game-assets/...
#   - REPLACE-WITH-RAILWAY-URL placeholder -> the real deployed Railway service URL
# The repo's own index.html keeps working unmodified against
# `python3 server.py` for local dev.
#
# STAMPEDE_LEADERBOARD_API must be set to the deployed leaderboard-service
# URL (e.g. https://stampede-leaderboard-production.up.railway.app) —
# Railway assigns/manages this, so it can't be hardcoded here the way the
# old Kinsta dev URL was.
#
# No --delete on the rsync of the plugin folder itself — this only ever adds
# forward; run a manual cleanup if a file needs to go away.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${STAMPEDE_LEADERBOARD_API:-}" ]; then
  echo "ERROR: STAMPEDE_LEADERBOARD_API is not set — export the deployed" >&2
  echo "leaderboard-service URL (no trailing slash) before running this script." >&2
  exit 1
fi

TARGET="${1:-staging}"
case "$TARGET" in
  staging)
    REMOTE_ALIAS="typhoontexasnew-staging"
    REMOTE_WP_PATH="/www/typhoontexasnew_475/public"
    GAME_URL="https://env-typhoontexasnew-dev.kinsta.cloud/stampede-wild-rush/play/"
    ;;
  production)
    REMOTE_ALIAS="typhoontexasnew-production"
    REMOTE_WP_PATH="/www/typhoontexasnew_475/public"
    GAME_URL="https://typhoontexas.com/stampede-wild-rush/play/"
    ;;
  *)
    echo "ERROR: unknown target '${TARGET}' — expected 'staging' or 'production'." >&2
    exit 1
    ;;
esac

REMOTE_PLUGIN_PATH="${REMOTE_WP_PATH}/wp-content/plugins/waterpark-leaderboard"
ASSET_URL_BASE="/wp-content/plugins/waterpark-leaderboard/game-assets/"
LOCAL_API_PLACEHOLDER="https://REPLACE-WITH-RAILWAY-URL.up.railway.app"

echo "== Target: ${TARGET} (${REMOTE_ALIAS}) =="

echo "== Staging game-assets/ from assets/ =="
rm -rf waterpark-leaderboard/game-assets
cp -R assets waterpark-leaderboard/game-assets

# A stray restrictive directory mode (e.g. 700 from however a folder got
# created) is invisible locally — the same user owns and can read it — but
# silently 404s once served by a different user (nginx/php-fpm) on staging.
# Caught this exact way once already (letter-collect/); normalize forward so
# it can't happen from an asset folder we haven't hit yet.
find waterpark-leaderboard/game-assets -type d -exec chmod 755 {} +
find waterpark-leaderboard/game-assets -type f -exec chmod 644 {} +

echo "== Rewriting index.html -> waterpark-leaderboard/game/index.html =="
mkdir -p waterpark-leaderboard/game
# Was quote-anchored (s#"assets/#...#g), which missed multi-line srcset
# continuation lines — e.g. #rideLogo's srcset wraps each candidate onto
# its own indented line with no leading quote, so only the first (the
# quoted src=/first srcset candidate) got rewritten and the rest 404'd on
# whichever DPR/width picked them. Every "assets/" occurrence in
# index.html is a real asset reference (confirmed — no false-positive
# risk), so match the bare substring instead of requiring a quote before it.
sed \
  -e "s#assets/#${ASSET_URL_BASE}#g" \
  -e "s#${LOCAL_API_PLACEHOLDER}#${STAMPEDE_LEADERBOARD_API}#g" \
  index.html > waterpark-leaderboard/game/index.html

echo "== Sanity-checking the rewrite =="
# ASSET_URL_BASE itself ends in "game-assets/", which contains the
# substring "assets/" — so counting bare "assets/" against "game-assets/"
# (rather than grep -q 'assets/', which would always false-positive on the
# rewritten paths themselves) is what actually proves nothing survived.
ASSETS_COUNT=$(grep -o 'assets/' waterpark-leaderboard/game/index.html | wc -l | tr -d ' ')
GAME_ASSETS_COUNT=$(grep -o 'game-assets/' waterpark-leaderboard/game/index.html | wc -l | tr -d ' ')
if [ "$ASSETS_COUNT" -ne "$GAME_ASSETS_COUNT" ]; then
  echo "ERROR: a bare (unrewritten) assets/ reference survived the sed pass" >&2
  exit 1
fi
if grep -q 'REPLACE-WITH-RAILWAY-URL' waterpark-leaderboard/game/index.html; then
  echo "ERROR: placeholder leaderboard API URL survived the sed pass" >&2
  exit 1
fi

echo "== Syncing plugin to ${TARGET} =="
rsync -az --exclude ".DS_Store" waterpark-leaderboard/ "${REMOTE_ALIAS}:${REMOTE_PLUGIN_PATH}/"

echo "== Flushing rewrite rules =="
ssh "${REMOTE_ALIAS}" "wp --path='${REMOTE_WP_PATH}' rewrite flush"

echo "== Done. Game served at: ${GAME_URL} =="
