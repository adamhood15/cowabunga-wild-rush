#!/usr/bin/env node
// Screenshot + overflow/collision probe for index.html, over the real DevTools
// protocol. Replaces the scratchpad scripts HANDOFF.md keeps losing —
// harness.js / shot.js — this one lives in the repo.
//
//   node tools/screenshot.js <screen> [viewport] [--out path.png] [--worst]
//
// <screen>   title | name | title-noname | play | over | over-won | board
// [viewport] phone412 (default) | w320 | w360 | w390 | w768 | desktop
// --worst    fills fields with worst-case content (long score, long name,
//            all letters lit) before capturing — empty states always fit.
//
// Prints a JSON report: { overflow: [...], screenshot: "path" }. Overflow
// entries are elements where getBoundingClientRect().right > clientWidth or
// scrollWidth > clientWidth, per AGENTS.md's verification method.

const fs = require("node:fs");
const path = require("node:path");
const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";

// finishLoading()'s tap-to-start gate only resolves on a REAL user-activation
// gesture (AGENTS.md: audio unlock needs Input.dispatchTouchEvent, a
// JS-dispatched event will never satisfy it). This probe is about layout, not
// audio, so it skips the gate directly rather than faking a gesture — the
// loader's own class toggle is copied here to keep the two paths in sync.
const SKIP_LOADER = `dismissLoader();`;

// Seeds the rider directly rather than calling Board.claim(), which is a real
// network call against the live Kinsta dev backend (DATABASE.md: Board's API
// is a temporary absolute URL) that this tool has no reason to depend on
// succeeding — these screens are about layout, not the naming flow. `score`
// is seeded well above anything a non---worst run here produces (max is
// over-won's ~14,000; SC_COIN/SC_LETTER, index.html) so Board.submit() never
// sees a "new best" and Board.rankOf() serves the pre-seeded `rank` from its
// own cache instead of making a live network read for a screenshot that
// doesn't need one. --worst intentionally exceeds this (coins: 98765432) and
// falls through to a real, read-only /rank call — acceptable there, since
// --worst is already an extreme-value mode.
const SEED_RIDER = `localStorage.setItem("stampede.rider.v1", JSON.stringify({
  name: "Test Rider", token: "test-token", score: 50000, at: Date.now(), rank: 12
}));`;

const SCREEN_SCRIPTS = {
  // Fresh visit: loader dismissed, then the naming reels (no rider on file yet).
  name: `
    localStorage.removeItem("stampede.rider.v1");
    localStorage.removeItem("stampede.board.v1");
    ${SKIP_LOADER}
    afterLoader();
  `,
  // Repeat visit (rider already on file) straight to the title card.
  title: `
    ${SEED_RIDER}
    ${SKIP_LOADER}
    afterLoader();
  `,
  play: `
    ${SEED_RIDER}
    ${SKIP_LOADER}
    start();
    if (WORST){
      coins = 98765432; shownLetters = WORD.length; gotLetters = WORD.length;
      paintLetters();
    }
    syncHUD();
  `,
  // Wipeout results card, word NOT spelled — "Wipeout" copy path.
  over: `
    ${SEED_RIDER}
    ${SKIP_LOADER}
    start();
    gotLetters = WORST ? 8 : 3;
    coins = WORST ? 98765432 : 640;
    metres = WORST ? 999999 : 1840;
    showOver();
  `,
  // Wipeout results card, word WAS spelled — exercises the "You Survived It"
  // copy, which HANDOFF flags as stale now that every run ends in a wipeout.
  "over-won": `
    ${SEED_RIDER}
    ${SKIP_LOADER}
    start();
    gotLetters = WORD.length;
    coins = WORST ? 98765432 : 1200;
    metres = WORST ? 999999 : 2400;
    showOver();
  `,
  board: `
    ${SEED_RIDER}
    ${SKIP_LOADER}
    openBoard();
  `,
  // Seeds the rider directly rather than calling Board.claim(), which is a
  // real network call against the live Kinsta dev backend (HANDOFF: Board's
  // API is a temporary absolute URL) — this screen is about layout, not the
  // naming flow, so it shouldn't depend on that round-trip succeeding.
  how: `
    localStorage.setItem("stampede.rider.v1", JSON.stringify({token:"t", player_name:"Test Rider", score:0}));
    ${SKIP_LOADER}
    afterLoader();
    openHow();
  `,
};

const OVERFLOW_PROBE = `
(() => {
  const results = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  document.querySelectorAll("body *").forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    // Elements fully off-screen (a panel mid-transition, a loader that has
    // faded away) are not a layout bug even if their own scrollWidth looks
    // odd — only judge boxes that actually intersect the visible viewport.
    const onscreen = r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    if (!onscreen) return;
    const overRight  = r.right  - vw;
    const overBottom = r.bottom - vh;
    const overLeft   = -r.left;
    const overTop    = -r.top;
    const scrollOverflowX = el.scrollWidth  - el.clientWidth;
    const worstOver = Math.max(overRight, overBottom, overLeft, overTop);
    // A couple of px of scrollWidth slop is normal sub-pixel rounding on flex
    // rows with letter-spacing; only flag it once it is visually meaningful.
    if (worstOver > 1 || scrollOverflowX > 4) {
      results.push({
        id: el.id || null,
        cls: el.className && typeof el.className === "string" ? el.className.slice(0, 60) : null,
        overRight: Math.round(overRight), overBottom: Math.round(overBottom),
        overLeft: Math.round(overLeft), overTop: Math.round(overTop),
        scrollOverflowX: Math.round(scrollOverflowX),
      });
    }
  });
  return results;
})()
`;

async function main() {
  const args = process.argv.slice(2);
  const screen = args[0];
  if (!screen || !SCREEN_SCRIPTS[screen]) {
    console.error("Usage: node tools/screenshot.js <screen> [viewport] [--out path] [--worst]");
    console.error("screens:", Object.keys(SCREEN_SCRIPTS).join(", "));
    process.exitCode = 1; return;
  }
  const viewportName = args[1] && VIEWPORTS[args[1]] ? args[1] : "phone412";
  const viewport = VIEWPORTS[viewportName];
  const outIdx = args.indexOf("--out");
  const worst = args.includes("--worst");
  const textIdx = args.indexOf("--text"); // quick copy-candidate testing, e.g. #overTitle
  const outPath = outIdx >= 0 ? args[outIdx + 1]
    : path.join(__dirname, `../.tmp-${screen}-${viewportName}.png`);

  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport });

    // Let the loader's asset fetch settle before forcing state — the page's
    // own for-loop over ART kicks off fetch()/decodeAudioData() on load, and
    // finishLoading() is safe to call before those resolve, but we want the
    // DOM in its post-loader shape (see AGENTS.md: force from window globals).
    await new Promise(r => setTimeout(r, 400));

    const script = SCREEN_SCRIPTS[screen].replace(/\bWORST\b/g, worst ? "true" : "false");
    await evaluate(session, script, { awaitPromise: false });
    // 600ms, not less: dismissLoader() fades #load over 500ms before adding
    // .gone (display:none) — screenshotting earlier catches it mid-fade,
    // still occupying layout with only its own opacity zeroed, which reads as
    // a false-positive "overflow" on loadTrack (opacity isn't inherited by
    // getComputedStyle, so the child still reports opacity:1).
    // showOver() holds the results card at opacity 0 until the settle
    // sequence finishes (OVER_HAND_MAX = 5s worst case) — see AGENTS.md
    // "Rider animation priority" / HANDOFF item 3's settleOverRider() note.
    const settleMs = (screen === "over" || screen === "over-won") ? 5200 : 600;
    await new Promise(r => setTimeout(r, settleMs));

    if (textIdx >= 0) {
      // e.g. --text "#overTitle=Round-Up Complete" to try a copy candidate
      // in place, without a real edit + reload per option.
      const [sel, ...rest] = args[textIdx + 1].split("=");
      const text = rest.join("=");
      await evaluate(session, `document.querySelector(${JSON.stringify(sel)}).textContent = ${JSON.stringify(text)}`);
      await new Promise(r => setTimeout(r, 50));
    }

    const overflow = await evaluate(session, OVERFLOW_PROBE);

    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));

    console.log(JSON.stringify({ screen, viewport: viewportName, worst, overflow, screenshot: outPath }, null, 2));
  } finally {
    // kill() is async — Chrome can still be flushing files to userDataDir
    // when rmSync runs right after, which raced into ENOTEMPTY. Wait for the
    // process to actually exit first.
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
