#!/usr/bin/env node
// Verifies the wipeout-to-results-card transition doesn't visibly "switch"
// color: deathWash() (index.html, render) paints a radial gradient on the
// CANVAS for the whole "dying" + "over" sequence specifically so #overPanel
// never needs a competing background of its own -- but #overPanel carries
// the shared .panel class, whose own opaque radial-gradient background was
// never actually turned off. The panel popping in (.on has no transition)
// therefore snapped from deathWash's blue to .panel's own indigo gradient in
// one frame -- two different colors, the second arriving edge-on. Fixed by
// `#overPanel{background:none}` in the CSS.
//
// Checks:
//   1. #overPanel resolves to no background image/color of its own -- the
//      actual regression guard. getImageData below only ever sees the CANVAS,
//      never the DOM #overPanel layered over it, so it cannot by itself catch
//      the panel's own background coming back; this computed-style check is
//      what would have failed before the CSS fix (confirmed by temporarily
//      reverting it and re-running, 2026-09-15).
//   2. Sampling the same on-screen canvas point (top-centre, where deathWash's
//      inner gradient stop sits) immediately before and immediately after the
//      "dying" -> "over" state flip shows a SMALL color delta -- proof
//      deathWash's OWN gradient math (the k formula switching from an eased
//      value to a flat 1) doesn't itself introduce a seam, independent of
//      whatever is or isn't layered on top of it in the DOM.
//
// node tools/death-wash-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SEED_RIDER = `localStorage.setItem("stampede.rider.v1", JSON.stringify({
  name: "Test Rider", token: "test-token", score: 0, at: Date.now()
}));`;

// Generous: two genuinely different hues (deathWash's blue vs .panel's old
// indigo) differ by ~50-100+ per channel at this point. A same-gradient
// continuity gap from frame-to-frame easing should be single digits.
const MAX_CHANNEL_DELTA = 20;

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));
    await evaluate(session, `${SEED_RIDER} dismissLoader(); afterLoader(); start();`);
    await new Promise(r => setTimeout(r, 200));

    const overPanelBg = await evaluate(session, `
      (() => {
        const s = getComputedStyle(document.getElementById("overPanel"));
        return { backgroundImage: s.backgroundImage, backgroundColor: s.backgroundColor };
      })()
    `);

    // Drive the wipeout directly rather than a real collision -- this check is
    // about the wash/panel color handoff, not hit detection.
    await evaluate(session, `gameOver();`);

    // Force right up to the edge of "dying", sample, then cross into "over"
    // and sample again at the same screen point.
    const before = await evaluate(session, `
      (() => {
        dieT = 0.02;
        update(0.01);
        render();
        const d = ctx.getImageData(Math.round(W/2), Math.round(H*0.15), 1, 1).data;
        return { state, px: [d[0], d[1], d[2]] };
      })()
    `);
    const after = await evaluate(session, `
      (() => {
        update(0.03);   // pushes dieT below 0 -> endRun() -> showOver() -> state "over"
        render();
        const d = ctx.getImageData(Math.round(W/2), Math.round(H*0.15), 1, 1).data;
        return { state, px: [d[0], d[1], d[2]] };
      })()
    `);

    const delta = before.px.map((v, i) => Math.abs(v - after.px[i]));
    const maxDelta = Math.max(...delta);

    console.log(JSON.stringify({ overPanelBg, before, after, delta, maxDelta }, null, 2));

    const bgIsNone = overPanelBg.backgroundImage === "none";
    const stateFlipped = before.state === "dying" && after.state === "over";
    const continuous = maxDelta <= MAX_CHANNEL_DELTA;

    console.log(`\n#overPanel background image is "none": ${bgIsNone}`);
    console.log(`state actually flips dying -> over: ${stateFlipped}`);
    console.log(`color delta at handoff: ${delta.join(",")} (max ${maxDelta}, allowed ${MAX_CHANNEL_DELTA}): ${continuous}`);

    process.exitCode = (bgIsNone && stateFlipped && continuous) ? 0 : 1;
    return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
