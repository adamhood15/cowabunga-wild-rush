#!/usr/bin/env node
// Verifies the perf-debug HUD instrumentation (index.html, PERF_DEBUG/perfTick,
// added 2026-08-27 for the real-device frame-rate profile TODOLIST.md flags
// as never having been done) actually works end to end: renders when opted
// in, stays completely absent otherwise, and reports sane numbers.
//
// This is NOT a substitute for the real-device profile itself — headless
// Chrome on a desktop CPU has nothing to do with a phone's GPU/thermal
// budget (AGENTS.md). It only proves the on-screen HUD a real device is
// meant to be read from is wired correctly, so pointing a phone at
// `?debugPerf` is worth trusting.
//
// node tools/perf-hud-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SEED_RIDER = `localStorage.setItem("stampede.rider.v1", JSON.stringify({
  name: "Test Rider", token: "test-token", score: 0, at: Date.now()
}));`;

async function main() {
  const chrome = await launchChrome({});
  try {
    // ---- 1. WITHOUT ?debugPerf: no HUD, flag off, zero DOM/behavior cost ----
    const { session: offSession } = await openPage({
      port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412,
    });
    await new Promise(r => setTimeout(r, 300));
    const offCheck = await evaluate(offSession, `({
      PERF_DEBUG: typeof PERF_DEBUG !== "undefined" ? PERF_DEBUG : null,
      hudExists: !!document.querySelector("div"),
      hudNode: (() => {
        // Look for any element matching the HUD's own distinctive styling
        // rather than an id (perfHud is a bare local var, not exposed by id).
        return Array.from(document.body.children).some(
          el => el.style && el.style.color === "rgb(0, 255, 0)" && el.style.fontFamily === "monospace"
        );
      })(),
    })`);

    // ---- 2. WITH ?debugPerf: HUD present, updates, reports sane numbers ----
    const { session } = await openPage({
      port: chrome.port, url: SERVER + "?debugPerf", viewport: VIEWPORTS.phone412,
    });
    const pageExceptions = [];
    session.on("Runtime.exceptionThrown", (p) => pageExceptions.push(p.exceptionDetails.text));

    await evaluate(session, `${SEED_RIDER} dismissLoader(); start();`);

    // Let the real rAF loop run long enough to fill PERF_WINDOW_MS (3000ms)
    // and paint at least a few throttled (500ms) HUD updates.
    await new Promise(r => setTimeout(r, 3600));

    const on = await evaluate(session, `
      (() => {
        const hud = Array.from(document.body.children).find(
          el => el.style && el.style.color === "rgb(0, 255, 0)" && el.style.fontFamily === "monospace"
        );
        return {
          PERF_DEBUG: typeof PERF_DEBUG !== "undefined" ? PERF_DEBUG : null,
          hudExists: !!hud,
          text: hud ? hud.textContent : null,
        };
      })()
    `);

    await new Promise(r => setTimeout(r, 50));   // let any async exception land

    const result = { offCheck, on, pageExceptions };
    console.log(JSON.stringify(result, null, 2));

    // Loose format check rather than exact-match: the HUD's own wording is
    // allowed to change, but it must always carry these figures.
    const text = on.text || "";
    const hasFps   = /FPS \d+ avg \/ \d+ p95/.test(text);
    const hasFrame = /frame [\d.]+ms avg \/ [\d.]+ms p95 \/ [\d.]+ms worst/.test(text);
    const hasWorstMeta = /worst@ [\d.]+s ents=\d+ streaks=\d+ state=\w+/.test(text);
    const hasJank  = /jank<30fps \d+  ents \d+  streaks \d+/.test(text);
    const hasDpr   = /DPR \d+(\.\d+)?  canvas \d+x\d+  state \w+/.test(text);

    const ok =
      offCheck.PERF_DEBUG === false &&
      offCheck.hudNode === false &&
      on.PERF_DEBUG === true &&
      on.hudExists === true &&
      hasFps && hasFrame && hasWorstMeta && hasJank && hasDpr &&
      pageExceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
