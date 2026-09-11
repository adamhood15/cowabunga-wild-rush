#!/usr/bin/env node
// Verifies the idle rider animation end to end over the real DevTools
// protocol: with nothing else active, drawRider() loops speed_01/02
// (IMG.speed0/speed1, the lightest speed-boost frames reused at rest) on a
// steady cadence -> it is the lowest-priority pose in the chain, so EVERY
// other animation (die/hurt/Season Pass/duck/eat/jump/whirlpool spin/speed
// boost/lane lean) interrupts it, never the reverse.
//
// node tools/idle-check.js

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

async function main() {
  const chrome = await launchChrome({});
  const pageExceptions = [];
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

    // Instrument ctx.drawImage to record which named sprite drawRider() blits,
    // by identity against IMG's own entries -- exercises the REAL priority
    // chain rather than re-deriving it in this script (same approach as
    // speedboost-check.js).
    await evaluate(session, `
      window.__origDrawImage = ctx.drawImage.bind(ctx);
      window.__lastRiderFrame = null;
      ctx.drawImage = function(img, ...args){
        for (const k in IMG){ if (IMG[k] === img){ window.__lastRiderFrame = k; break; } }
        return window.__origDrawImage(img, ...args);
      };
      true
    `);

    // Zero out every other pose-driving flag so idle is the only claimant.
    const CLEAR = `
      state = "play"; dieT = 0; hurtT = 0; seasonPassT = 0; duckA = 0; tuckT = 0;
      eatT = 0; jumpT = -1; whirlpoolT = 0; boostT = 0; boostSuper = false;
      moveT = 0; moveDir = 0;
    `;

    // 1. Frame function cycles between 0 and 1 on IDLE_FRAME_DUR, not a
    // one-shot -- sampled directly rather than through wall-clock sleeps.
    const frameCycle = await evaluate(session, `
      (() => {
        const at = (secs) => idleFrame(secs);
        return {
          f0:   at(0),
          mid0: at(IDLE_FRAME_DUR * 0.5),
          f1:   at(IDLE_FRAME_DUR * 1.01),
          mid1: at(IDLE_FRAME_DUR * 1.5),
          f2:   at(IDLE_FRAME_DUR * 2.01),   // back to frame 0 -- it's a loop
        };
      })()
    `);

    // 2. With nothing else active, drawRider actually blits the idle loop.
    const idleDraws = await evaluate(session, `
      (() => {
        ${CLEAR}
        const seen = new Set();
        for (let i = 0; i < 40; i++){
          window.__lastRiderFrame = null;
          drawRider();
          seen.add(window.__lastRiderFrame);
        }
        return [...seen];
      })()
    `);

    // 3. Every higher-priority animation interrupts it -- none of them
    // should ever leave idle's speed0/speed1 on screen.
    const vsDie = await evaluate(session, `
      (() => { ${CLEAR} state = "dying"; dieT = 0.5;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; state = "play"; dieT = 0;
        return { frame }; })()
    `);
    const vsHurt = await evaluate(session, `
      (() => { ${CLEAR}
        // hurtT drives a visible blink (drawRider's own early-return), so pick
        // a value landing on an ON frame rather than HURT_DUR itself, which
        // happens to land on an OFF one.
        hurtT = 1.3; lives = 1;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; hurtT = 0;
        return { frame }; })()
    `);
    const vsSeasonPass = await evaluate(session, `
      (() => { ${CLEAR} seasonPassT = SEASONPASS_DUR;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; seasonPassT = 0;
        return { frame }; })()
    `);
    const vsDuck = await evaluate(session, `
      (() => { ${CLEAR} duckA = 1;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; duckA = 0;
        return { frame }; })()
    `);
    const vsEat = await evaluate(session, `
      (() => { ${CLEAR} eatT = EAT_DUR;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; eatT = 0;
        return { frame }; })()
    `);
    const vsJump = await evaluate(session, `
      (() => { ${CLEAR} jumpT = 0.1;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; jumpT = -1;
        return { frame }; })()
    `);
    const vsWhirlpool = await evaluate(session, `
      (() => { ${CLEAR} whirlpoolT = 3;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; whirlpoolT = 0;
        return { frame }; })()
    `);
    const vsBoost = await evaluate(session, `
      (() => { ${CLEAR} boostSuper = true; boostT = BOOST_DUR / 2;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; boostT = 0; boostSuper = false;
        return { frame }; })()
    `);
    const vsLean = await evaluate(session, `
      (() => { ${CLEAR} moveT = 0.3; moveDir = 1;
        window.__lastRiderFrame = null; drawRider();
        const frame = window.__lastRiderFrame; moveT = 0; moveDir = 0;
        return { frame }; })()
    `);

    // 4. Renders across many frames with the loop live, without throwing.
    await evaluate(session, `
      ${CLEAR}
      for (let i = 0; i < 90; i++){ update(0.016); render(); }
      true
    `);

    await new Promise(r => setTimeout(r, 50));   // let any async exception land

    const result = {
      frameCycle, idleDraws,
      vsDie, vsHurt, vsSeasonPass, vsDuck, vsEat, vsJump, vsWhirlpool, vsBoost, vsLean,
      pageExceptions,
    };
    console.log(JSON.stringify(result, null, 2));

    const idleSet = new Set(idleDraws);
    const ok =
      frameCycle.f0 === 0 && frameCycle.mid0 === 0 &&
      frameCycle.f1 === 1 && frameCycle.mid1 === 1 &&
      frameCycle.f2 === 0 &&
      idleDraws.length > 0 &&
      [...idleSet].every(f => f === "speed0" || f === "speed1") &&
      vsDie.frame && vsDie.frame.startsWith("die") &&
      vsHurt.frame && vsHurt.frame.startsWith("hurt") &&
      vsSeasonPass.frame && vsSeasonPass.frame.startsWith("sp") &&
      vsDuck.frame && vsDuck.frame.startsWith("duck") &&
      vsEat.frame && vsEat.frame.startsWith("eat") &&
      vsJump.frame && vsJump.frame.startsWith("flip") &&
      vsWhirlpool.frame && vsWhirlpool.frame.startsWith("spin") &&
      vsBoost.frame && vsBoost.frame.startsWith("speed") &&
      vsLean.frame && vsLean.frame.startsWith("mv") &&
      pageExceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
