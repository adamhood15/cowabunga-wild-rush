#!/usr/bin/env node
// Verifies the WP-hosted gate + blank-template route deployed by
// tools/deploy.sh (see ARCHITECTURE.md#tooling for the CDP conventions
// this follows).
//
//   STAMPEDE_STAGING_URL=https://env-typhoontexasnew-dev.kinsta.cloud \
//     node tools/gate-check.js [viewport]
//
// Checks:
//   1. GAME_PATH with no token redirects away (doesn't serve the game).
//   2. A token from /gate-token lets GAME_PATH?t=... actually boot the game.
//   3. No theme/plugin chrome (nav/header/footer, extra stylesheets) leaked
//      into the blank-template response.
//   4. Screenshots the booted game at a phone viewport.

const fs = require("node:fs");
const path = require("node:path");
const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const BASE = process.env.STAMPEDE_STAGING_URL || "https://env-typhoontexasnew-dev.kinsta.cloud";
// Must match Waterpark_Leaderboard_Game_Router's rewrite rule.
const GAME_PATH = "/stampede-wild-rush/play/";

async function main() {
  const viewportName = process.argv[2] && VIEWPORTS[process.argv[2]] ? process.argv[2] : "phone412";
  const viewport = VIEWPORTS[viewportName];

  console.log("== Fetching gate token ==");
  const tokenRes = await fetch(`${BASE}/wp-json/waterpark-leaderboard/v1/gate-token`);
  const { token } = await tokenRes.json();
  if (!token) throw new Error("No token returned from /gate-token");
  console.log("  token:", token);

  const chrome = await launchChrome({});
  try {
    console.log(`== Loading ${GAME_PATH} with no token (expect redirect away) ==`);
    const noToken = await openPage({ port: chrome.port, url: `${BASE}${GAME_PATH}`, viewport });
    const noTokenUrl = await evaluate(noToken.session, "location.href");
    if (noTokenUrl.includes(GAME_PATH)) {
      throw new Error(`Gate did not redirect an unauthenticated ${GAME_PATH} request — landed on ${noTokenUrl}`);
    }
    console.log("  redirected to:", noTokenUrl, "(OK)");

    console.log(`== Loading ${GAME_PATH}?t=<token> (expect the game to boot) ==`);
    const { session } = await openPage({ port: chrome.port, url: `${BASE}${GAME_PATH}?t=${token}`, viewport });

    const chromeCheck = await evaluate(session, `({
      hasStage: !!document.querySelector("#stage"),
      hasNav: !!document.querySelector("nav, header, footer, #wpadminbar"),
      styleSheetCount: document.styleSheets.length,
      title: document.title,
    })`);
    console.log("  page shape:", JSON.stringify(chromeCheck));
    if (!chromeCheck.hasStage) throw new Error("#stage not found — game did not render");
    if (chromeCheck.hasNav) throw new Error("Found nav/header/footer/admin-bar — theme chrome leaked into the blank template");

    await new Promise(r => setTimeout(r, 400)); // let the loader's asset fetch settle, per screenshot.js
    await evaluate(session, "dismissLoader(); afterLoader(); Board.claim('Test Rider'); start();");
    await new Promise(r => setTimeout(r, 600));

    const outPath = path.join(__dirname, `../.tmp-gate-check-${viewportName}.png`);
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));

    console.log(JSON.stringify({ ok: true, viewport: viewportName, screenshot: outPath }, null, 2));
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
