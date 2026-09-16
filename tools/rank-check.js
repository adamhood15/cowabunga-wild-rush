#!/usr/bin/env node
// Consolidated verification for the rank/leaderboard-fetching subsystem:
// setRankFigures(), Board.rankOf(), and the results card's fRank figure.
// Merges three formerly-separate scripts (rank-flaky-network-check.js,
// rank-race-check.js, rank-debug-log-check.js) that all exercised the same
// subsystem end-to-end — kept as one file per AGENTS.md's tools-review
// effort. Each scenario below still reports its own PASS/FAIL; main()
// combines them into one overall verdict/exit code.
//
// fetch is stubbed in-page throughout, so every scenario is deterministic
// and hits no real API.
//
// node tools/rank-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";

// ---------------------------------------------------------------------------
// Scenario 1: retry-on-network-failure
//
// Verifies the fix for the reported bug: on a run's FIRST completion, the
// results card's fRank figure cycled (loading cue) then settled on "—"
// instead of a number, but opening the leaderboard right after showed the
// real rank. Root cause (confirmed before the fix, see git history):
// setRankFigures()/Board.rankOf() made exactly ONE network attempt and
// returned null (rendered as "—") on any failure — timeout, abort, non-OK
// status, thrown exception — with no retry, while the leaderboard's own
// INDEPENDENT /rank lookup got a fresh shot at the network and usually
// succeeded.
//
// Fix: rankOf() now retries once (RANK_RETRY_ATTEMPTS / RANK_RETRY_DELAY_MS
// in index.html) before giving up. This checks both ends of that: a single
// transient failure should now recover within the SAME lookup (scenario A),
// and a fully dead endpoint should still degrade to "—" rather than retry
// forever (scenario B).
// ---------------------------------------------------------------------------
async function checkRetryOnNetworkFailure(chrome) {
  const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
  await new Promise(r => setTimeout(r, 400));

  const result = await evaluate(session, `
    (async () => {
      // ---- Scenario A: one transient failure, then the retry succeeds ----
      let callsA = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        const u = String(url);
        if (u.includes("/rank?score=500")) {
          callsA++;
          if (callsA === 1) {
            // First attempt fails, as a transient network blip would.
            return Promise.reject(new TypeError("network error (simulated)"));
          }
          // The retry succeeds.
          return Promise.resolve(new Response(JSON.stringify({ rank: 42 }), { status: 200 }));
        }
        if (u.includes("/submit")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        return realFetch(url, opts);
      };

      localStorage.setItem("stampede.rider.v1",
        JSON.stringify({ name: "Testy", token: "testtoken", score: 0, at: Date.now() }));

      const el = document.getElementById("fRank");

      pendingScore = 500;
      syncRankRow();                     // results card after the run ends

      await new Promise(r => setTimeout(r, 900));  // let the failed attempt + retry settle

      const scenarioA = {
        callsA,
        resultsCardText: el.textContent,
        resultsCardClass: el.className,
        meScore: Board.me().score,
        meRank: Board.me().rank,
      };

      // ---- Scenario B: every attempt fails — must still degrade to "—",
      // not retry forever ----
      localStorage.setItem("stampede.rider.v1",
        JSON.stringify({ name: "Testy2", token: "testtoken2", score: 0, at: Date.now() }));
      let callsB = 0;
      window.fetch = (url, opts) => {
        const u = String(url);
        if (u.includes("/rank?score=700")) {
          callsB++;
          return Promise.reject(new TypeError("network error (simulated)"));
        }
        if (u.includes("/submit")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        return realFetch(url, opts);
      };

      pendingScore = 700;
      syncRankRow();
      await new Promise(r => setTimeout(r, 900));

      const scenarioB = {
        callsB,
        resultsCardText: el.textContent,
        resultsCardClass: el.className,
      };

      window.fetch = realFetch;
      return { scenarioA, scenarioB };
    })()
  `, { awaitPromise: true });

  console.log(JSON.stringify(result, null, 2));
  const { scenarioA, scenarioB } = result;

  const ok =
    scenarioA.callsA === 2 &&                       // first attempt + one retry
    scenarioA.resultsCardText === "#42" &&           // retry's rank won, not "—"
    !scenarioA.resultsCardClass.includes("calculating") &&
    scenarioA.meScore === 500 && scenarioA.meRank === 42 &&
    scenarioB.callsB === 2 &&                        // still bounded — no infinite retry
    scenarioB.resultsCardText === "—" &&             // a truly dead endpoint still degrades cleanly
    !scenarioB.resultsCardClass.includes("calculating");

  console.log(ok
    ? "PASS: a single transient /rank failure now recovers via retry; a fully dead endpoint still degrades to — after a bounded number of attempts."
    : "FAIL — behavior does not match expectations, investigate further.");
  return ok;
}

// ---------------------------------------------------------------------------
// Scenario 2: race-condition ordering / requestId guard
//
// Verifies the fix for the "results card shows the old rank" bug: two runs
// finished back-to-back fire two overlapping /rank lookups, and the slower
// one (for the WORSE, earlier score) used to win if it resolved after the
// faster one (for the BETTER, later score) — both by overwriting the DOM
// figure and by corrupting the cached rider record in localStorage. Fixed by
// setRankFigures()'s requestId guard and rankOf()'s re-read-before-write.
//
// Also checks the "calculating" cue itself: the figure should visibly cycle
// through random numbers while a lookup is in flight (not just sit on the
// stale one), the superseded run 1 cycle should go inert the instant run 2
// starts rather than fight it for the DOM, and prefers-reduced-motion should
// suppress the cycling entirely.
// ---------------------------------------------------------------------------
async function checkRaceConditionOrdering(chrome) {
  const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
  await new Promise(r => setTimeout(r, 400));

  const result = await evaluate(session, `
    (async () => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        const u = String(url);
        // Run 1: worse score, SLOW response — arrives after run 2's.
        if (u.includes("/rank?score=100")) {
          return new Promise(resolve => setTimeout(() =>
            resolve(new Response(JSON.stringify({ rank: 15 }), { status: 200 })), 400));
        }
        // Run 2: better score, FAST response — should win.
        if (u.includes("/rank?score=200")) {
          return new Promise(resolve => setTimeout(() =>
            resolve(new Response(JSON.stringify({ rank: 10 }), { status: 200 })), 20));
        }
        // Reduced-motion scenario's single slow lookup.
        if (u.includes("/rank?score=300")) {
          return new Promise(resolve => setTimeout(() =>
            resolve(new Response(JSON.stringify({ rank: 7 }), { status: 200 })), 300));
        }
        if (u.includes("/submit")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        return realFetch(url, opts);
      };

      localStorage.setItem("stampede.rider.v1",
        JSON.stringify({ name: "Testy", token: "testtoken", score: 0, at: Date.now() }));

      const el = document.getElementById("fRank");

      pendingScore = 100;
      syncRankRow();                                  // run 1 finishes
      const midFlightClass = el.classList.contains("f-rank--calculating");
      const midFlightMeScore = Board.me().score;

      // Sample the figure a few times while run 1's lookup is the only one
      // in flight — the cycling effect should be visibly changing it.
      const run1Samples = [el.textContent];
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 40));
        run1Samples.push(el.textContent);
      }
      const run1Cycled = new Set(run1Samples).size > 1;

      pendingScore = 200;
      syncRankRow();                                   // run 2 finishes moments later

      await new Promise(r => setTimeout(r, 500));      // let both lookups settle

      const raceResult = {
        midFlightClass, midFlightMeScore, run1Cycled,
        finalText: el.textContent,
        finalClass: el.className,
        meScore: Board.me().score,
        meRank: Board.me().rank,
      };

      // Reduced motion: the cycling should not run at all — the figure
      // sits still on whatever it last showed until the real rank lands.
      const realMatchMedia = window.matchMedia;
      window.matchMedia = (q) => ({ matches: q.includes("prefers-reduced-motion"), addListener(){}, removeListener(){} });
      try {
        pendingScore = 300;
        el.textContent = "#10";                         // known starting value to watch for changes
        syncRankRow();
        const reducedSamples = [el.textContent];
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 40));
          reducedSamples.push(el.textContent);
        }
        const reducedStaticMidFlight = new Set(reducedSamples).size === 1;
        await new Promise(r => setTimeout(r, 400));      // let the slow lookup land
        var reducedResult = { reducedStaticMidFlight, finalText: el.textContent };
      } finally {
        window.matchMedia = realMatchMedia;
      }

      return { raceResult, reducedResult };
    })()
  `, { awaitPromise: true });

  console.log(JSON.stringify(result, null, 2));
  const { raceResult, reducedResult } = result;

  const ok =
    raceResult.midFlightClass === true &&               // cycling while run 1's lookup was pending
    raceResult.midFlightMeScore === 100 &&               // submit(100) landed before run 2 started
    raceResult.run1Cycled === true &&                    // the figure actually changed, not just a class
    raceResult.finalText === "#10" &&                    // run 2's rank won, not run 1's stale #15
    !raceResult.finalClass.includes("calculating") &&    // settled, not left mid-animation
    raceResult.meScore === 200 &&                        // rider record has the later run's score
    raceResult.meRank === 10 &&                          // ...and its correct rank, not stomped by run 1
    reducedResult.reducedStaticMidFlight === true &&     // reduced motion: no cycling
    reducedResult.finalText === "#7";                    // ...but the real rank still lands

  console.log(ok ? "PASS" : "FAIL");
  return ok;
}

// ---------------------------------------------------------------------------
// Scenario 3: debug logging output
//
// Verifies the rank diagnostic logging added 2026-08-27: silent by default,
// and when armed via localStorage.setItem("stampede.debug.rank","1") (or
// ?debugRank), traces score submitted / score passed to rankOf() / cache vs
// network / the /rank response / leaderboard position, all prefixed "[rank]".
//
// RANK_DEBUG is captured once at page load (a manual toggle, not something
// that needs to react mid-session), so arming it via localStorage after the
// page already loaded intentionally has NO effect until reload — the
// "armed" run below reloads to pick it up, matching how a real user would
// use it. Each run gets its own page (fresh console listener + fresh load)
// rather than reusing one across the silent/armed cases.
// ---------------------------------------------------------------------------
async function runDebugLogCase(chrome, { armDebug }) {
  const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
  const rankLogs = [];
  session.on("Runtime.consoleAPICalled", (p) => {
    const text = (p.args || []).map(a => a.value !== undefined ? a.value : a.description).join(" ");
    if (text.startsWith("[rank]")) rankLogs.push(text);
  });
  await new Promise(r => setTimeout(r, 400));

  const stubFetchAndRider = `
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes("/rank?score=")) {
        return Promise.resolve(new Response(JSON.stringify({ rank: 33 }), { status: 200 }));
      }
      if (u.includes("/leaderboard")) {
        return Promise.resolve(new Response(JSON.stringify([
          { player_name: "Someone Else", score: 99999 },
        ]), { status: 200 }));
      }
      if (u.includes("/submit")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return realFetch(url, opts);
    };
    localStorage.setItem("stampede.rider.v1", JSON.stringify({
      name: "Boomin' Kayak", token: "testtoken", score: 8680, at: Date.now()
    }));
  `;

  await evaluate(session, `
    (async () => {
      ${armDebug ? 'localStorage.setItem("stampede.debug.rank", "1");' : ''}
      ${stubFetchAndRider}
      return true;
    })()
  `, { awaitPromise: true });

  if (armDebug) {
    // Reload so RANK_DEBUG's one-time read at load picks up the flag.
    const loaded = session.once("Page.loadEventFired");
    await session.send("Page.reload", {});
    await loaded;
    await new Promise(r => setTimeout(r, 400));
    await evaluate(session, `(() => { ${stubFetchAndRider} })()`);
  }

  await evaluate(session, `
    (async () => {
      pendingScore = 7300;
      syncRankRow();
      await new Promise(r => setTimeout(r, 400));
      await openBoard(true);
    })()
  `, { awaitPromise: true });

  return rankLogs;
}

async function checkDebugLoggingOutput(chrome) {
  const silentLogs = await runDebugLogCase(chrome, { armDebug: false });
  const armedLogs = await runDebugLogCase(chrome, { armDebug: true });

  console.log("Silent-mode [rank] logs:", silentLogs.length);
  console.log("Armed-mode [rank] logs:");
  armedLogs.forEach(l => console.log("  " + l));

  const ok =
    silentLogs.length === 0 &&
    armedLogs.some(l => l.includes("submit() score 7300 does not beat standing best 8680")) &&
    armedLogs.some(l => l.includes("rankOf() cache hit — score 8680 rank 33") || l.includes("rankOf() cache miss for score 8680")) &&
    armedLogs.some(l => l.includes("renderBoard()"));

  console.log(ok ? "PASS" : "FAIL");
  return ok;
}

// ---------------------------------------------------------------------------

async function main() {
  const chrome = await launchChrome({});
  try {
    console.log("=== Scenario 1: retry-on-network-failure ===");
    const retryOk = await checkRetryOnNetworkFailure(chrome);

    console.log("\n=== Scenario 2: race-condition ordering / requestId guard ===");
    const raceOk = await checkRaceConditionOrdering(chrome);

    console.log("\n=== Scenario 3: debug logging output ===");
    const debugLogOk = await checkDebugLoggingOutput(chrome);

    const ok = retryOk && raceOk && debugLogOk;
    console.log(`\n=== Overall: ${ok ? "PASS" : "FAIL"} ===`);
    console.log(`retry-on-network-failure: ${retryOk ? "PASS" : "FAIL"}`);
    console.log(`race-condition ordering: ${raceOk ? "PASS" : "FAIL"}`);
    console.log(`debug logging output: ${debugLogOk ? "PASS" : "FAIL"}`);

    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
