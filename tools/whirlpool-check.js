#!/usr/bin/env node
// Verifies the Whirlpool power-up end to end over the real DevTools protocol:
// pickup starts the 6s magnet -> nearby coins AND letters ease toward the
// rider's own lane/depth over several frames -> each is collected through
// its ordinary T.COIN/T.LETTER branch (score/word progress, entity removed)
// -> a survived hit does NOT cancel the effect (Adam's call, unlike Fast
// Pass's boost) -> a fatal hit (gameOver) DOES stop it, so the loop sound
// can't outlive the run -- AND the loop-trim audio fix: whirlpool.mp3 fades
// in/out at its own head and tail, so looping the whole buffer made every
// cycle audibly dip near-silent at the seam. Sound.loopStart() sets
// loopSrc.loopStart/loopEnd to confine the REPEATING portion to the
// sustained middle, skipping the fades -- the exact offsets are
// zero-crossing points measured against Chrome's own decodeAudioData output
// (see index.html's LOOP_TRIM comment), not the raw mp3 file, since decoders
// trim/resample differently.
//
// node tools/whirlpool-check.js

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

const EXPECT_LOOP_START = 0.0699;
const EXPECT_LOOP_END = 1.4651;
const LOOP_TOLERANCE = 0.005; // seconds — decode/frame-alignment slack

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

    // 1. Pickup starts the timer and the magnet begins pulling a nearby coin
    // AND a nearby letter, both planted off to one side, several units
    // ahead — outside the ordinary pickup window, which is the whole point
    // of the magnet.
    const pickup = await evaluate(session, `
      (() => {
        const before = { whirlpoolT, coins, gotLetters };
        add(T.WHIRLPOOL, travelled + 0.05, 0);
        const coinE = add(T.COIN, travelled + 4, 1);     // off-lane, 4 units ahead
        const letterE = add(T.LETTER, travelled + 4, -1); // off-lane, opposite side
        letterE.gi = gotLetters;                          // the next letter the word needs
        update(0.016);
        const afterPickup = {
          whirlpoolT, entLeft: ents.some(e => e.t === T.WHIRLPOOL && !e.dead),
        };
        for (let i = 0; i < 240 && !(coinE.dead && letterE.dead); i++){
          update(0.016);
        }
        return {
          before, afterPickup,
          coinCollected: coinE.dead, coinsAfter: coins,
          letterCollected: letterE.dead, gotLettersAfter: gotLetters,
        };
      })()
    `);

    // 2. A SURVIVED hit must NOT cancel the magnet (Adam's explicit call).
    const survivedHit = await evaluate(session, `
      (() => {
        whirlpoolT = 3.2; lives = 3; invuln = 0;
        const before = whirlpoolT;
        hitRider();
        return { before, after: whirlpoolT, livesLeft: lives };
      })()
    `);

    // 3. A FATAL hit (gameOver) must stop it — nothing else ever will once
    // state leaves "play".
    const fatalHit = await evaluate(session, `
      (() => {
        whirlpoolT = 4.0; lives = 1; invuln = 0;
        const before = whirlpoolT;
        hitRider();
        return { before, after: whirlpoolT, state };
      })()
    `);

    // 4. Rendering the active cue and the world pickup's own glow must not throw.
    await evaluate(session, `
      reset(); state = "play";
      add(T.WHIRLPOOL, travelled + 3, 0);
      whirlpoolT = 3; whirlpoolAngle = 1.2;
      for (let i = 0; i < 30; i++){ update(0.016); render(); }
      true
    `);

    // 5. Loop-trim audio fix — inspect the real AudioBufferSourceNode
    // Sound.loopStart() creates (via a createBufferSource() patch) rather
    // than trusting the source code, since decodeAudioData's exact frame
    // alignment is a browser-decoder detail this check should catch
    // drifting. Sound.unlock() runs at top-level module load (index.html:
    // 7412), which kicks off the whirlpool.mp3 fetch+decode — poll until it
    // lands rather than sleeping a guessed duration.
    let loopNode = null;
    for (let i = 0; i < 25 && !loopNode; i++) {
      await new Promise(r => setTimeout(r, 200));
      loopNode = await evaluate(session, `
        (() => {
          let captured = null;
          const proto = (window.AudioContext || window.webkitAudioContext).prototype;
          const real = proto.createBufferSource;
          proto.createBufferSource = function(){
            const n = real.call(this);
            captured = n;
            return n;
          };
          Sound.loopStart("whirlpool", 0.5);
          proto.createBufferSource = real;
          if (!captured || !captured.buffer) return null;
          const result = {
            loop: captured.loop,
            loopStart: captured.loopStart,
            loopEnd: captured.loopEnd,
            bufferDuration: captured.buffer.duration,
          };
          Sound.loopStop();
          return result;
        })()
      `);
    }

    await new Promise(r => setTimeout(r, 50));   // let any async exception land

    console.log(JSON.stringify({ pickup, survivedHit, fatalHit, loopNode, pageExceptions }, null, 2));

    const ok =
      pickup.before.whirlpoolT === 0 &&
      pickup.afterPickup.whirlpoolT === 6.0 &&   // granted THIS frame; decrement runs from the next frame on
      pickup.afterPickup.entLeft === false &&
      pickup.coinCollected === true &&                       // the planted coin swirled in and was collected
      pickup.coinsAfter > pickup.before.coins &&
      pickup.letterCollected === true &&                     // the planted letter was pulled in too
      pickup.gotLettersAfter > pickup.before.gotLetters &&
      survivedHit.after === survivedHit.before &&            // untouched by a survivable hit
      survivedHit.livesLeft === 2 &&                         // a normal hit still costs a life either way
      fatalHit.after === 0 &&                                // cleared once the run actually ends
      fatalHit.state === "dying" &&
      loopNode !== null &&
      loopNode.loop === true &&
      Math.abs(loopNode.loopStart - EXPECT_LOOP_START) < LOOP_TOLERANCE &&
      Math.abs(loopNode.loopEnd - EXPECT_LOOP_END) < LOOP_TOLERANCE &&
      loopNode.bufferDuration > loopNode.loopEnd &&
      pageExceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
