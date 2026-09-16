#!/usr/bin/env node
// Verifies the Season Pass power-up's two-phase timing over the real
// DevTools protocol:
// - grabbing it freezes the world (seasonPassIntroT) rather than starting the
//   mechanical effect immediately -- travelled/speed/collisions all hold
//   still while the reveal animation (sp0-sp5) steps through
// - the freeze ends and the world resumes exactly when seasonPassIntroT hits
//   0, at which point seasonPassT (the real effect) starts, its music takes
//   the channel, and the rider holds on sp5 (season-pass_06)
// - only NOW is the player actually invincible / faster / magnetic -- a hit
//   during the frozen reveal would be a bug (nothing should be able to touch
//   the rider while the world is frozen anyway, but the guard is checked)
// - it only ever spawns once per run
// - the outro (sp6-sp10) plays in the last SEASONPASS_OUTRO_DUR of seasonPassT
//   and the whole effect + its music end together
// - the outro is ALSO frozen, same as the intro reveal -- travelled/collisions
//   hold still through it, but seasonPassT keeps ticking down inside the
//   freeze so the "ride" music handoff lands at exactly the same instant it
//   always did
// - the invuln/Season-Pass flash on the rider sprite is suppressed once
//   inside that frozen outro window, so the send-off reads clean instead of
//   getting stuck on whatever flash phase it entered on
//
// node tools/seasonpass-check.js

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

function ok(label, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + " - " + label + (detail !== undefined ? " (" + JSON.stringify(detail) + ")" : ""));
  return cond;
}

async function main() {
  const chrome = await launchChrome({});
  let allPass = true;
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 400));

    await evaluate(session, `
      window.__safeCount = 0;
      const origSeasonPassSafe = Sound.seasonPassSafe.bind(Sound);
      Sound.seasonPassSafe = function(){ window.__safeCount++; return origSeasonPassSafe(); };
      ${SEED_RIDER}
      ${SKIP_LOADER}
      start();
      lane = 0; laneA = 0;
    `);

    // --- Pickup: starts the FROZEN intro, not the mechanical effect ---
    const grabbed = await evaluate(session, `
      (() => {
        spawnEntity(ENTITY_TYPE.SEASONPASS, travelled + 0.05, 0);
        update(0.016);
        return { seasonPassIntroT, seasonPassT, travelledAfter: travelled };
      })()
    `);
    allPass &= ok("pickup starts the frozen intro, not the effect", grabbed.seasonPassIntroT > 1.7 && grabbed.seasonPassT === 0, grabbed);

    // --- World is frozen during intro: travelled should not advance over many frames ---
    const frozen = await evaluate(session, `
      (() => {
        const before = travelled;
        for (let i = 0; i < 30; i++) update(0.016);   // ~0.48s, still well inside the 1.8s intro
        return { before, after: travelled, seasonPassIntroT };
      })()
    `);
    allPass &= ok("travelled does not advance during the frozen reveal", frozen.after === frozen.before, frozen);
    allPass &= ok("still mid-intro after ~0.5s of a 1.8s intro", frozen.seasonPassIntroT > 1.2 && frozen.seasonPassIntroT < 1.4, frozen);

    // --- Reveal animation steps through frames during the freeze ---
    const introFrame = await evaluate(session, `seasonPassFrame()`);
    allPass &= ok("reveal animation is mid-way through 01-06 partway into the intro", introFrame >= 1 && introFrame <= 4, introFrame);

    // --- A hazard during the freeze can't touch the rider (nothing collides -- collision loop doesn't run) ---
    const duringFreeze = await evaluate(session, `
      (() => {
        const livesBefore = lives;
        spawnEntity(ENTITY_TYPE.COW, travelled + 0.05, 0);   // would be in the hit window if collisions ran
        for (let i = 0; i < 10; i++) update(0.016);
        return { livesBefore, livesAfter: lives, seasonPassIntroT };
      })()
    `);
    allPass &= ok("no life lost during the frozen reveal (collision loop doesn't run)", duringFreeze.livesAfter === duringFreeze.livesBefore, duringFreeze);

    // --- Run the intro out: world resumes, effect + music start, frame holds on index 5 ---
    const resumed = await evaluate(session, `
      (() => {
        while (seasonPassIntroT > 0.02) update(0.016);
        update(0.05);   // cross the 0 boundary
        return { seasonPassIntroT, seasonPassT, frame: seasonPassFrame() };
      })()
    `);
    allPass &= ok("world resumes into the effect once the intro ends", resumed.seasonPassIntroT === 0 && resumed.seasonPassT > 8.9, resumed);
    allPass &= ok("rider holds on frame index 5 (season-pass_06) right after resuming", resumed.frame === 5, resumed);

    // --- Now travelled DOES advance, and speed climbs toward SEASONPASS_SPEED_MULT x maxSpeed ---
    const speedState = await evaluate(session, `
      (() => { const t0 = travelled; for (let i = 0; i < 400; i++) update(0.016); return { advanced: travelled > t0, speed, maxSpeed: CONFIG.maxSpeed, mult: SEASONPASS_SPEED_MULT }; })()
    `);
    allPass &= ok("travelled advances once resumed", speedState.advanced, speedState);
    allPass &= ok("speed climbs toward SEASONPASS_SPEED_MULT x maxSpeed", Math.abs(speedState.speed - speedState.maxSpeed * speedState.mult) < 0.05, speedState);

    // --- Invincibility now that the effect is truly active ---
    const beforeLives = await evaluate(session, "lives");
    await evaluate(session, `
      (() => { window.__safeCount = 0; spawnEntity(ENTITY_TYPE.COW, travelled + 0.05, 0); update(0.016); })()
    `);
    const afterHit = await evaluate(session, `({ lives, safeCount: window.__safeCount })`);
    allPass &= ok("cow hit during the active effect costs no life", afterHit.lives === beforeLives, { beforeLives, afterHit });
    allPass &= ok("cow hit during the active effect fires the safe cue", afterHit.safeCount >= 1, afterHit);

    // --- Run down to the frozen outro's threshold, then verify the freeze ---
    const atOutro = await evaluate(session, `
      (() => {
        while (seasonPassT > SEASONPASS_OUTRO_DUR) update(0.016);
        return { seasonPassT, frame: seasonPassFrame() };
      })()
    `);
    allPass &= ok("crossed into the outro window", atOutro.seasonPassT <= 1.8 && atOutro.seasonPassT > 1.0, atOutro);

    const outroFrozen = await evaluate(session, `
      (() => {
        const before = travelled;
        for (let i = 0; i < 20; i++) update(0.016);   // well inside the 1.8s outro
        return { before, after: travelled, seasonPassT };
      })()
    `);
    allPass &= ok("travelled does not advance during the frozen outro", outroFrozen.after === outroFrozen.before, outroFrozen);

    const duringOutroFreeze = await evaluate(session, `
      (() => {
        const livesBefore = lives;
        spawnEntity(ENTITY_TYPE.COW, travelled + 0.05, 0);
        for (let i = 0; i < 10; i++) update(0.016);
        return { livesBefore, livesAfter: lives, seasonPassT };
      })()
    `);
    allPass &= ok("no life lost during the frozen outro (collision loop doesn't run)", duringOutroFreeze.livesAfter === duringOutroFreeze.livesBefore, duringOutroFreeze);

    // --- The invuln/Season-Pass flash must be OFF for the whole frozen outro ---
    const flashDuringOutro = await evaluate(session, `
      (() => { window.__saves = 0; const orig = ctx.save.bind(ctx);
        ctx.save = function(){ window.__saves++; return orig(); };
        const drawsAt = [];
        for (let i = 0; i < 24; i++){ window.__saves = 0; drawRider(); drawsAt.push(window.__saves); runT += 1/12; }
        ctx.save = orig;
        return { drawsAt, allDrawn: drawsAt.every(n => n > 0) };
      })()
    `);
    allPass &= ok("rider is drawn every frame through the frozen outro (flash suppressed)", flashDuringOutro.allDrawn, flashDuringOutro);

    // --- Sanity: the SAME flash mechanism DOES skip frames outside the outro window ---
    const flashOutsideOutro = await evaluate(session, `
      (() => {
        const savedT = seasonPassT; seasonPassT = SEASONPASS_DUR;   // deep into the effect, well before the outro
        window.__saves = 0; const orig = ctx.save.bind(ctx);
        ctx.save = function(){ window.__saves++; return orig(); };
        const drawsAt = [];
        for (let i = 0; i < 24; i++){ window.__saves = 0; drawRider(); drawsAt.push(window.__saves); runT += 1/12; }
        ctx.save = orig; seasonPassT = savedT;
        return { drawsAt, someSkipped: drawsAt.some(n => n === 0) };
      })()
    `);
    allPass &= ok("flash mechanism still skips frames well before the outro (sanity check)", flashOutsideOutro.someSkipped, flashOutsideOutro);

    // --- Run the outro out: everything (timer, music handoff) ends at the same instant ---
    const musicSpy = await evaluate(session, `
      (() => {
        window.__musicCalls = [];
        const orig = Sound.music.bind(Sound);
        Sound.music = function(name, cb, vol){ window.__musicCalls.push(name); return orig(name, cb, vol); };
        return true;
      })()
    `);
    const expiry = await evaluate(session, `
      (() => {
        const beforeTravelled = travelled;
        while (seasonPassT > 0.02) update(0.016);
        const frameJustBefore = seasonPassFrame();
        update(0.05);
        return { frameJustBefore, seasonPassT, travelledAdvanced: travelled > beforeTravelled, musicCalls: window.__musicCalls };
      })()
    `);
    allPass &= ok("animation reaches the last frame (index 10) as the effect ends", expiry.frameJustBefore === 10, expiry);
    allPass &= ok("seasonPassT reaches exactly 0", expiry.seasonPassT === 0, expiry);
    allPass &= ok("travelled still frozen for the run-out of the outro", !expiry.travelledAdvanced, expiry);
    allPass &= ok("music hands back to \"ride\" exactly once, at the same instant as before", expiry.musicCalls.filter(n => n === "ride").length === 1, expiry);

    // --- One-per-run ---
    const onceState = await evaluate(session, `
      (() => {
        reset(); state = "play";
        seasonPassSpawned = true;
        let sawSeasonPassAgain = false;
        for (let i = 0; i < 400; i++){
          ents = ents.filter(e => e.t !== ENTITY_TYPE.SEASONPASS);
          powerupZ = travelled - 1;
          spawnPowerup();
          if (ents.some(e => e.t === ENTITY_TYPE.SEASONPASS)) sawSeasonPassAgain = true;
          travelled += 1;
        }
        return { sawSeasonPassAgain };
      })()
    `);
    allPass &= ok("Season Pass never spawns again once seasonPassSpawned is set", !onceState.sawSeasonPassAgain, onceState);

    console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
