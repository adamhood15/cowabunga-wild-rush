#!/usr/bin/env node
// Verifies drawRider()'s invulnerability flash: the whole rider sprite blinks
// on/off (12Hz, keyed to runT) in every window a hit can't land in -- post-hit
// i-frames and the win-reveal hold (both just `invuln`), and Season Pass's
// unconditional invincibility (`seasonPassT`) -- and stays fully rendered
// (no flash) during ordinary riding and while `lives === 0` (so a fatal hit's
// own crash pose is never intermittently hidden).
//
// node tools/invuln-flash-check.js

const fs = require("node:fs");
const path = require("node:path");
const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SKIP_LOADER = `dismissLoader();`;
// Seeds the rider directly rather than calling Board.claim(), which is a
// real network call against the live Kinsta dev backend (DATABASE.md) that
// this power-up check has no reason to depend on -- it never reaches
// showOver()/Board.submit(), so no rank caching is needed either.
const SEED_RIDER = `localStorage.setItem("stampede.rider.v1", JSON.stringify({
  name: "Test Rider", token: "test-token", score: 0, at: Date.now()
}));`;
const OUT_DIR = path.join(__dirname, "..", ".tmp-invuln-flash-check");

async function main() {
  const chrome = await launchChrome({});
  const pageExceptions = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    session.on("Runtime.exceptionThrown", (p) => pageExceptions.push(p.exceptionDetails.text));
    await new Promise(r => setTimeout(r, 400));

    await evaluate(session, `
      ${SEED_RIDER}
      ${SKIP_LOADER}
      start();
      lane = 0; laneA = 0;
    `);

    // Count drawImage calls per drawRider() invocation, rather than which
    // sprite -- the flash is an early return before ANY blit, so "0 calls"
    // is exactly what "flashed off" means, distinct from every other frame
    // where drawRider() draws the rider under some pose.
    await evaluate(session, `
      window.__origDrawImage = ctx.drawImage.bind(ctx);
      window.__drawCount = 0;
      ctx.drawImage = function(...args){
        window.__drawCount++;
        return window.__origDrawImage(...args);
      };
      true
    `);

    // Sweep runT across a couple of full 12Hz periods (1/12s each) at a
    // fixed invuln/seasonPassT/hurtT/lives combo, calling drawRider()
    // directly (not update()) so the timers under test hold still while
    // only runT -- the actual flash clock -- moves.
    const sweep = (setup) => `
      (() => {
        state = "play"; dieT = 0; jumpT = -1; tuckT = 0; duckA = 0;
        eatT = 0; whirlpoolT = 0; moveT = 0;
        ${setup}
        const drew = [];
        for (let t = 0; t < 0.2; t += 0.01){
          runT = t;
          window.__drawCount = 0;
          drawRider();
          drew.push(window.__drawCount > 0);
        }
        return drew;
      })()
    `;

    const hitIframes = await evaluate(session, sweep(`invuln = 1.4; hurtT = 1.4; lives = 3;`));
    const winReveal   = await evaluate(session, sweep(`invuln = WIN_INVULN; hurtT = 0; lives = 3;`));
    const seasonPass  = await evaluate(session, sweep(`invuln = 0; hurtT = 0; seasonPassT = SEASONPASS_DUR; lives = 3;`));
    const normalRide  = await evaluate(session, sweep(`invuln = 0; hurtT = 0; seasonPassT = 0; lives = 3;`));
    const zeroLives   = await evaluate(session, sweep(`invuln = 1.4; hurtT = 1.4; seasonPassT = 0; lives = 0;`));

    // Visual sanity pass on the real phone viewport: Season Pass already
    // draws its own held pose + full-screen overlay, so grab both flash
    // phases and eyeball that hiding the rider sprite doesn't also blank
    // out (or otherwise corrupt) the rest of the scene. The page's own
    // frame() loop calls update(realDt) every rAF tick regardless of what
    // this script sets, which would silently tick runT/seasonPassT out from
    // under a screenshot taken after an async round trip -- stop it first
    // so only the explicit render() calls below touch the canvas.
    await evaluate(session, `window.requestAnimationFrame = () => 0; true`);
    await new Promise(r => setTimeout(r, 50));   // let any already-queued frame() land

    await evaluate(session, `
      state = "play"; dieT = 0; jumpT = -1; tuckT = 0; duckA = 0;
      eatT = 0; whirlpoolT = 0; moveT = 0; lives = 3;
      invuln = 0; hurtT = 0; seasonPassIntroT = 0; seasonPassT = SEASONPASS_DUR;
      runT = 0; render();
      true
    `);
    const onShot = await session.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "seasonpass-flash-on.png"), Buffer.from(onShot.data, "base64"));

    await evaluate(session, `runT = 0.05; render(); true`);
    const offShot = await session.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "seasonpass-flash-off.png"), Buffer.from(offShot.data, "base64"));

    await new Promise(r => setTimeout(r, 50));   // let any async exception land

    const result = { hitIframes, winReveal, seasonPass, normalRide, zeroLives, pageExceptions };
    console.log(JSON.stringify(result, null, 2));

    // "Actually flashes" = both true and false appear across the sweep, not
    // just "isn't drawn every single frame" (which a stuck-off render would
    // also satisfy).
    const flashes = (drew) => drew.includes(true) && drew.includes(false);
    const neverHides = (drew) => drew.every(d => d === true);

    const ok =
      flashes(hitIframes) &&
      flashes(winReveal) &&
      flashes(seasonPass) &&
      neverHides(normalRide) &&
      neverHides(zeroLives) &&
      pageExceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    console.log(`Screenshots: ${OUT_DIR}`);
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
