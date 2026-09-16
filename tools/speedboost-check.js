#!/usr/bin/env node
// Verifies the speed-boost rider animation end to end over the real DevTools
// protocol: BOTH triggers that share boostT/boostSuper (a tunnel and the Fast
// Pass pickup) grant the same timer -> drawRider actually blits speed_01..04
// while boostT is running, ramping 1->4, flickering between 3/4 through the
// middle, then ramping back 4->1 as boostT approaches 0 -> the animation
// steps aside for anything it must not interrupt (die/hurt/jump/duck/eat/
// whirlpool spin) and picks back up for a plain lane lean.
//
// node tools/speedboost-check.js

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
    // chain rather than re-deriving it in this script.
    await evaluate(session, `
      window.__origDrawImage = ctx.drawImage.bind(ctx);
      window.__lastRiderFrame = null;
      ctx.drawImage = function(img, ...args){
        for (const k in IMG){ if (IMG[k] === img){ window.__lastRiderFrame = k; break; } }
        return window.__origDrawImage(img, ...args);
      };
      true
    `);

    // 1. Both triggers grant the identical timer.
    const tunnelTrigger = await evaluate(session, `
      (() => {
        boostT = 0; boostSuper = false;
        const e = add(T.TUNNEL, travelled + 0.05, 0, 3);
        update(0.016);
        return { boostT, boostSuper, triggered: e.triggered };
      })()
    `);
    const speedBoostPickupTrigger = await evaluate(session, `
      (() => {
        boostT = 0; boostSuper = false;
        const e = add(T.BOOST, travelled + 0.05, 0);
        update(0.016);
        return { boostT, boostSuper, dead: e.dead };
      })()
    `);

    // 2. Frame ramp: 0 (fresh trigger) -> flickers between 3/4 through the
    // hold (sampled across several boostT values so either flicker phase
    // passes) -> back down to 0 (tail end).
    const rampStart = await evaluate(session, `
      (() => {
        state = "play"; dieT = 0; hurtT = 0; jumpT = -1; tuckT = 0; duckA = 0;
        eatT = 0; whirlpoolT = 0; moveT = 0;
        boostSuper = true; boostT = BOOST_DUR;
        window.__lastRiderFrame = null;
        drawRider();
        return { frame: window.__lastRiderFrame, boostT };
      })()
    `);
    const holdFrames = await evaluate(session, `
      (() => {
        const frames = [];
        for (let bt = BOOST_DUR - 0.6; bt > 0.6; bt -= 0.05){
          boostT = bt;
          window.__lastRiderFrame = null;
          drawRider();
          frames.push(window.__lastRiderFrame);
        }
        return frames;
      })()
    `);
    const rampTail = await evaluate(session, `
      (() => {
        boostT = 0.02;
        window.__lastRiderFrame = null;
        drawRider();
        return { frame: window.__lastRiderFrame, boostT };
      })()
    `);

    // 3. Must not interrupt (or be interrupted by) anything already ranked
    // above it -- whirlpool spin, and while we're at it duck/jump/hurt/eat,
    // which the same priority chain now has to keep working around it.
    const vsWhirlpool = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR / 2; whirlpoolT = 3;
        window.__lastRiderFrame = null;
        drawRider();
        const frame = window.__lastRiderFrame;
        whirlpoolT = 0;
        return { frame };
      })()
    `);
    const vsDuck = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR / 2; duckA = 1;
        window.__lastRiderFrame = null;
        drawRider();
        const frame = window.__lastRiderFrame;
        duckA = 0;
        return { frame };
      })()
    `);
    const vsJump = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR / 2; jumpT = 0.1;
        window.__lastRiderFrame = null;
        drawRider();
        const frame = window.__lastRiderFrame;
        jumpT = -1;
        return { frame };
      })()
    `);
    const vsEat = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR / 2; eatT = EAT_DUR;
        window.__lastRiderFrame = null;
        drawRider();
        const frame = window.__lastRiderFrame;
        eatT = 0;
        return { frame };
      })()
    `);

    // 4. With nothing above it active, speed boost still outranks a plain lane lean.
    const vsLean = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR / 2; moveT = 0.3; moveDir = 1;
        window.__lastRiderFrame = null;
        drawRider();
        const frame = window.__lastRiderFrame;
        moveT = 0; moveDir = 0;
        return { frame };
      })()
    `);

    // 5. A survived hit clears boostT (unlike whirlpool) -- confirm the
    // animation actually stops, not just that the timer hit zero. Idle now
    // has its own dedicated cowIdle1/cowIdle2 art (cowabunga-idle_02/03.png),
    // so the fired frame should be a "cowIdle*" key -- confirm the render
    // matches idleFrame()'s own deterministic formula -- i.e. the idle
    // branch is what actually fired, not some other pose coincidentally
    // landing on the same sprite name.
    const clearedByHit = await evaluate(session, `
      (() => {
        boostSuper = true; boostT = BOOST_DUR; lives = 3; invuln = 0; hurtT = 0;
        hitRider();
        window.__lastRiderFrame = null;
        // isolate the boost read from the post-hit state the hit itself starts:
        // hurtT is the hurt POSE, invuln is the i-frame BLINK -- drawRider()
        // skips the draw call entirely on alternating beats of a 12Hz flash
        // while invuln > 0 (see its "Flash while invulnerable" block), so
        // leaving invuln set makes this step's pass/fail a coin flip on
        // whatever wall-clock instant it happens to run at (caught when an
        // unrelated render-cost change elsewhere shifted the ambient rAF
        // loop's timing just enough to flip which beat this landed on).
        hurtT = 0; invuln = 0;
        const expectedIdle = "cowIdle" + idleFrame(performance.now() * 0.001);
        drawRider();
        return { boostTAfterHit: boostT, frame: window.__lastRiderFrame, expectedIdle };
      })()
    `);

    // 6. The whole ramp renders across many frames without throwing.
    await evaluate(session, `
      reset(); state = "play";
      boostSuper = true; boostT = BOOST_DUR;
      for (let i = 0; i < 200 && boostT > 0; i++){ update(0.016); render(); }
      true
    `);

    await new Promise(r => setTimeout(r, 50));   // let any async exception land

    const result = {
      tunnelTrigger, speedBoostPickupTrigger,
      rampStart, holdFrames, rampTail,
      vsWhirlpool, vsDuck, vsJump, vsEat, vsLean,
      clearedByHit,
      pageExceptions,
    };
    console.log(JSON.stringify(result, null, 2));

    const holdSet = new Set(holdFrames);
    const ok =
      tunnelTrigger.boostT === 2.4 && tunnelTrigger.boostSuper === true && tunnelTrigger.triggered === true &&
      speedBoostPickupTrigger.boostT === 2.4 && speedBoostPickupTrigger.boostSuper === true && speedBoostPickupTrigger.dead === true &&
      rampStart.frame === "speed0" &&
      holdFrames.length > 0 &&
      [...holdSet].every(f => f === "speed2" || f === "speed3") &&
      holdSet.has("speed2") && holdSet.has("speed3") &&   // actually flickers, doesn't sit flat
      rampTail.frame === "speed0" &&
      vsWhirlpool.frame && vsWhirlpool.frame.startsWith("spin") &&
      vsDuck.frame && vsDuck.frame.startsWith("duck") &&
      vsJump.frame && vsJump.frame.startsWith("flip") &&
      vsEat.frame && vsEat.frame.startsWith("eat") &&
      vsLean.frame && vsLean.frame.startsWith("speed") &&
      clearedByHit.boostTAfterHit === 0 &&
      clearedByHit.frame === clearedByHit.expectedIdle &&
      pageExceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
