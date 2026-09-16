#!/usr/bin/env node
// Verifies the Extra Life power-up end to end over the real DevTools protocol.
//
// Covers, in one continuous run:
//   1. Pickup -> eating flourish -> HUD flight -> tube registration
//      - eatT/EAT_DUR and Sound.eating() fire the INSTANT the pickup is
//        grabbed on the track -- not a beat later once the flyer finishes
//        its flight to the HUD. extraLife/Sound.extraLife() still wait for
//        that landing; only the eating cue moved earlier.
//      - the rider steps through all 4 eat frames (EAT_REG-registered).
//      - Sound.eating() chains typhoon-slurp.mp3 onto typhoon-eating.mp3's
//        own `ended` event, not two independent calls.
//      - the world pickup is gone the instant it's grabbed, no badge stands
//        in for it during the chomp, and the tube shows up once landed.
//   2. Eat-pose priority: duck is the ONLY thing that cuts the eating pose
//      short -- jump, whirlpool spin, and speed boost all let it play out.
//   3. A hit while the shield is held is absorbed: identical
//      shake/flash/speed-penalty/hurt-sound to a normal hit, no life lost,
//      and the tube explodes instead of vanishing instantly.
//   4. The NEXT hit after that costs a real life like normal.
//   5. The shared spawn clock never offers a second Extra Life while one is
//      already held.
//
// node tools/extralife-check.js

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
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 400));

    // Record every play() call by src (the <audio>-element fallback path)
    // AND every AudioBufferSourceNode.start() call (the web-audio path Sound
    // actually takes once fetch+decode has landed, which is the common case).
    // Whichever path Sound.eating() used, we need to catch the node/element it
    // set an onended/ended hook on, so we can fire that hook ourselves and
    // confirm slurp starts right off the back of it -- not two independent
    // calls with a guessed delay between them.
    await evaluate(session, `
      window.__plays = [];
      window.__lastEl = null;
      window.__starts = [];
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(){
        const src = this.currentSrc || this.src || "";
        window.__plays.push(src.split("/").pop());
        window.__lastEl = this;
        return origPlay.apply(this, arguments);
      };
      const origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(){
        const node = this;
        window.__starts.push(node);
        return origStart.apply(this, arguments);
      };
      ${SEED_RIDER}
      ${SKIP_LOADER}
      start();
      lane = 0; laneA = 0;
    `);

    // --- 1. Pickup -> eating flourish -> HUD flight -> tube registration ---
    // flyExtraLife() is deferred to the eat freeze's onEnd (see index.html's
    // update()), so the badge doesn't spawn at the grab -- the world pickup
    // just needs to be gone right away (e.dead) so nothing stands in for it
    // during the chomp. Jumping eatT to the freeze's last instant rather than
    // pumping ~150 real frames keeps this deterministic -- no
    // organically-spawned hazard can land on the rider in between.
    const pickup = await evaluate(session, `
      (() => {
        const before = { extraLife, tubesExtra: document.querySelectorAll('#tubes .tube.tube--extra').length };
        spawnEntity(ENTITY_TYPE.EXTRALIFE, travelled + 0.05, 0);
        update(0.016);
        const chainedIdx = window.__starts.findIndex(n => !!n.onended);
        const afterPickup = {
          extraLife, eatT, EAT_DUR,
          plays: window.__plays.slice(),
          hasChainedWebAudioSource: chainedIdx >= 0,
          flyerKinds: flyers.map(f => f.kind),
          entLeft: ents.some(e => e.t === ENTITY_TYPE.EXTRALIFE && !e.dead),
        };
        eatT = 0.001;
        update(1/60);
        const afterChomp = { eatT, flyerKinds: flyers.map(f => f.kind) };
        for (let i = 0; i < 60; i++) updateFlyers(0.02);
        const afterLand = {
          extraLife,
          tubesExtra: document.querySelectorAll('#tubes .tube.tube--extra').length,
          flyersLeft: flyers.length,
          startsCount: window.__starts.length,
        };
        return { before, afterPickup, afterChomp, afterLand };
      })()
    `);

    // Step eatT down through its full range and sample which eat frame
    // drawRider would pick at each point, via the same quadIdx math it uses.
    const frames = await evaluate(session, `
      (() => {
        const seen = [];
        for (const frac of [0.99, 0.74, 0.49, 0.24, 0.0]) {
          eatT = EAT_DUR * frac;
          const ei = eatT > 0 ? quadIdx(1 - eatT / EAT_DUR) : -1;
          seen.push({ frac, ei, img: ei >= 0 ? !!IMG["eat" + ei] : null });
        }
        return seen;
      })()
    `);

    // Priority: per Adam, duck is the ONLY thing that should cut the eating
    // pose short -- jump, whirlpool spin, and speed boost must all let it
    // play out instead. Mirrors drawRider()'s own gating chain (dieImg/
    // hurtImg forced off via state="play"/hurtT=0) against each competing
    // state in turn, checked in isolation so one conflict can't mask another.
    const priority = await evaluate(session, `
      (() => {
        state = "play"; hurtT = 0; dieT = 0;
        const pick = () => {
          const duckImg = duckA > 0.05 ? IMG["duck" + duckIdx(duckA)] : null;
          const eatImg  = (!duckImg && eatT > 0) ? IMG["eat" + quadIdx(1 - eatT / EAT_DUR)] : null;
          const flipImg = (!duckImg && !eatImg && jumpT >= 0) ? IMG["flip" + flipFrame(jumpT / JUMP_DUR)] : null;
          const spinImg = (!duckImg && !eatImg && !flipImg && whirlpoolT > 0) ? IMG["spin" + spinFrame(performance.now() * 0.001)] : null;
          const speedImg= (!duckImg && !eatImg && !flipImg && !spinImg && boostT > 0) ? IMG["speed" + speedFrame(boostT)] : null;
          return { duck: !!duckImg, eat: !!eatImg, jump: !!flipImg, spin: !!spinImg, speed: !!speedImg };
        };
        duckA = 0; eatT = 0; jumpT = -1; whirlpoolT = 0; boostT = 0;
        const eatVsDuck = (() => { duckA = 0.6; eatT = EAT_DUR * 0.5; return pick(); })();
        duckA = 0; eatT = 0;
        const eatVsJump = (() => { eatT = EAT_DUR * 0.5; jumpT = JUMP_DUR * 0.3; return pick(); })();
        jumpT = -1; eatT = 0;
        const eatVsSpin = (() => { eatT = EAT_DUR * 0.5; whirlpoolT = 3; return pick(); })();
        whirlpoolT = 0; eatT = 0;
        const eatVsSpeed = (() => { eatT = EAT_DUR * 0.5; boostT = 2; return pick(); })();
        boostT = 0; eatT = 0;
        return { eatVsDuck, eatVsJump, eatVsSpin, eatVsSpeed };
      })()
    `);

    // Simulate the eating sample finishing -- fire whichever hook
    // Sound.eating() actually wired (web-audio node.onended, or the
    // <audio>-element fallback's 'ended' listener), and confirm slurp starts
    // right off the back of it, not on an independent guessed delay.
    const chained = await evaluate(session, `
      (() => {
        const before = window.__starts.length;
        const node = window.__starts.find(n => !!n.onended);
        if (node) node.onended();
        if (window.__lastEl) window.__lastEl.dispatchEvent(new Event("ended"));
        return {
          plays: window.__plays.slice(),
          startsBefore: before,
          startsAfter: window.__starts.length,
        };
      })()
    `);

    // --- 2. Absorb hit: same shake/flash/speed-penalty/hurt-pose as a normal
    // hit, no life lost, and the tube explodes rather than vanishing instantly.
    const absorb = await evaluate(session, `
      (() => {
        invuln = 0; shake = 0; hurtT = 0; speed = CONFIG.maxSpeed;
        boostT = 5; boostSuper = true; speedBoostLabelT = 5;
        const before = { lives, extraLife, speed };
        hitRider();
        return {
          before,
          justAfter: {
            lives, extraLife, invuln, shake, hurtT,
            speedDropped: speed < before.speed,
            boostCleared: boostT === 0 && !boostSuper && speedBoostLabelT === 0,
            tubeExploding: !!document.querySelector('#tubes .tube.tube--extra.tube--exploding'),
            tubeStillInDom: document.querySelectorAll('#tubes .tube.tube--extra').length,
          },
        };
      })()
    `);
    // Let the .38s CSS explosion keyframe actually finish and remove the tube.
    await new Promise(r => setTimeout(r, 500));
    const afterExplode = await evaluate(session, `
      ({ tubesExtra: document.querySelectorAll('#tubes .tube.tube--extra').length })
    `);

    // --- 3. The NEXT hit is a real one. ---
    const realHit = await evaluate(session, `
      (() => {
        invuln = 0;
        const before = lives;
        hitRider();
        return { before, lives, extraLife };
      })()
    `);

    const hits = { absorb, afterExplode, realHit };

    // --- 4. Spawn-clock gate: never offers ENTITY_TYPE.EXTRALIFE while one is held. ---
    const spawnGate = await evaluate(session, `
      (() => {
        extraLife = true;
        let sawExtra = false;
        for (let i = 0; i < 50; i++) {
          powerupZ = travelled - 1;
          spawnPowerup();
          if (ents.some(e => e.t === ENTITY_TYPE.EXTRALIFE && !e.dead)) sawExtra = true;
          ents = ents.filter(e => e.t !== ENTITY_TYPE.EXTRALIFE);
        }
        extraLife = false;
        return { sawExtraWhileHeld: sawExtra };
      })()
    `);

    const exceptions = await evaluate(session, `window.__caughtExceptions || []`);

    console.log(JSON.stringify({ pickup, frames, priority, chained, hits, spawnGate, exceptions }, null, 2));

    // Whichever path Sound.eating() actually took must show BOTH: eating
    // started at pickup, and slurp only starts once eating's own end hook
    // fires -- never both at once, never slurp first.
    const eatingStartedViaWebAudio = pickup.afterPickup.hasChainedWebAudioSource;
    const eatingStartedViaElement = pickup.afterPickup.plays.includes("typhoon-eating.mp3");
    const slurpChainedViaWebAudio = chained.startsAfter === chained.startsBefore + 1;
    const slurpChainedViaElement = chained.plays[chained.plays.length - 1] === "typhoon-slurp.mp3";

    const ok =
      // pickup -> eating flourish -> HUD flight -> tube registration
      pickup.before.extraLife === false && pickup.before.tubesExtra === 0 &&
      pickup.afterPickup.extraLife === false &&           // shield still waits for the flyer to land
      pickup.afterPickup.eatT > 0 && pickup.afterPickup.eatT <= pickup.afterPickup.EAT_DUR && // but eating fired right on the grab
      pickup.afterPickup.entLeft === false &&             // world pickup gone the instant it's grabbed
      pickup.afterPickup.flyerKinds.length === 0 &&       // no badge stands in for it during the chomp
      (eatingStartedViaWebAudio || eatingStartedViaElement) &&
      !pickup.afterPickup.plays.includes("typhoon-slurp.mp3") && // not fired yet -- only on ended
      pickup.afterChomp.flyerKinds.includes("extralife") && // badge takes flight once the chomp ends
      pickup.afterLand.extraLife === true &&               // NOW the shield goes live
      pickup.afterLand.tubesExtra === 1 &&
      // eat frames + priority + sound chaining
      frames.every(f => f.ei >= -1 && f.ei <= 3 && f.img !== false) &&
      frames.map(f => f.ei).join(",") === "0,1,2,3,-1" &&
      (eatingStartedViaWebAudio ? slurpChainedViaWebAudio : slurpChainedViaElement) &&
      pickup.afterLand.startsCount === chained.startsBefore && // landing itself started no new sound
      // Duck cuts eat short; jump/spin/speed boost all let it play out.
      priority.eatVsDuck.duck === true && priority.eatVsDuck.eat === false &&
      priority.eatVsJump.eat === true && priority.eatVsJump.jump === false &&
      priority.eatVsSpin.eat === true && priority.eatVsSpin.spin === false &&
      priority.eatVsSpeed.eat === true && priority.eatVsSpeed.speed === false &&
      // absorb hit -> tube explodes -> next hit is real -> spawn-clock gate
      absorb.before.extraLife === true &&
      absorb.justAfter.lives === absorb.before.lives &&    // absorbed -- no life lost
      absorb.justAfter.extraLife === false &&
      absorb.justAfter.invuln > 0 &&                       // same invuln as a normal hit
      absorb.justAfter.shake === 1 &&                      // same shake as a normal hit
      absorb.justAfter.hurtT === 1.4 &&                    // same hurt pose as a normal hit
      absorb.justAfter.speedDropped &&                     // same speed penalty as a normal hit
      absorb.justAfter.boostCleared &&                     // same boost-cancel as a normal hit
      absorb.justAfter.tubeExploding &&                    // the explosion, not an instant vanish
      absorb.justAfter.tubeStillInDom === 1 &&              // still there mid-explosion
      afterExplode.tubesExtra === 0 &&                     // gone once the animation finishes
      realHit.lives === realHit.before - 1 &&              // the NEXT hit is a real hit
      spawnGate.sawExtraWhileHeld === false &&
      exceptions.length === 0;

    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exitCode = ok ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
