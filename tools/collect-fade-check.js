#!/usr/bin/env node
// Verifies the collected word's fade (replaced the old frozen "surge"
// run-off, 2026-09-17 — Adam's call to stop pausing the game for it) over
// the real DevTools protocol: landing the last letter should NOT freeze the
// world (travel/spawns/collisions all stay live) while #letters.letters--fade
// plays and Sound.collect() sounds, layered over whatever music is already
// playing rather than cutting it. WIN_INVULN must cover the grab-to-landing
// flight AND the fade itself, since a hazard can now actually reach the
// rider during the celebration. #letters gets "gone" once COLLECT_FADE_DUR
// elapses.
//
// node tools/collect-fade-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SKIP_LOADER = `dismissLoader();`;
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
      window.__musicStops = []; window.__musicStarts = [];
      const origStop = Sound.musicStop.bind(Sound);
      Sound.musicStop = function(fade){ window.__musicStops.push(fade); return origStop(fade); };
      const origMusic = Sound.music.bind(Sound);
      Sound.music = function(key, vol, fadeIn, onFail){ window.__musicStarts.push(key); return origMusic(key, vol, fadeIn, onFail); };
      ${SEED_RIDER}
      ${SKIP_LOADER}
      start();
      lane = 0; laneA = 0;
      // Fast-forward through every letter but the last -- only the final
      // letter's landing is under test here.
      gotLetters = WORD.length - 1;
      shownLetters = WORD.length - 1;
    `);

    // --- Grab the last letter: gotLetters advances and WIN_INVULN is granted,
    // but the fade (fadeT) doesn't start yet -- it only begins once the flyer
    // LANDS in the HUD. ---
    const grabbed = await evaluate(session, `
      (() => {
        const e = spawnEntity(ENTITY_TYPE.LETTER, travelled + 0.05, 0);
        e.gi = gotLetters;
        update(0.016);
        return { gotLetters, shownLetters, fadeT, flyersLen: flyers.length, invuln, WIN_INVULN, wordLength: WORD.length };
      })()
    `);
    allPass &= ok("grabbing the last letter advances gotLetters and grants WIN_INVULN, but not yet the fade", grabbed.gotLetters === grabbed.wordLength && grabbed.fadeT === -1 && grabbed.flyersLen === 1 && grabbed.invuln >= grabbed.WIN_INVULN - 0.001, grabbed);

    // --- Run the flight out to FLY_LAND: fade starts, sound fires, music is
    // NOT stopped, and -- unlike the old frozen version -- travel/collisions
    // keep running the whole time. ---
    const landed = await evaluate(session, `
      (() => {
        window.__collectSounds = 0;
        const orig = Sound.collect.bind(Sound);
        Sound.collect = function(){ window.__collectSounds++; return orig(); };
        const stopsBefore = window.__musicStops.length;
        for (let i = 0; i < 60 && fadeT < 0; i++) update(0.016);
        return {
          shownLetters, fadeT, COLLECT_FADE_DUR, wordLength: WORD.length,
          hasFadeClass: byId("letters").classList.contains("letters--fade"),
          collectSounds: window.__collectSounds,
          musicStoppedOnLanding: window.__musicStops.length > stopsBefore,
        };
      })()
    `);
    allPass &= ok("landing the flyer starts the fade at COLLECT_FADE_DUR and the sound", landed.shownLetters === landed.wordLength && landed.fadeT > landed.COLLECT_FADE_DUR - 0.1 && landed.hasFadeClass && landed.collectSounds === 1, landed);
    allPass &= ok("music is NOT stopped when the fade starts -- the sound layers over it", !landed.musicStoppedOnLanding, landed);

    // --- The world stays live through the fade: travel advances and a hazard
    // can still collide -- but WIN_INVULN should be covering the rider right
    // now, so the hit must not cost a life. ---
    const liveDuringFade = await evaluate(session, `
      (() => {
        const before = travelled;
        const livesBefore = lives;
        spawnEntity(ENTITY_TYPE.COW, travelled + 0.05, 0);
        update(0.016);
        return { before, after: travelled, livesBefore, livesAfter: lives, fadeT, invuln, worldFrozen: worldFrozen() };
      })()
    `);
    allPass &= ok("travelled keeps advancing during the fade (no freeze)", liveDuringFade.after > liveDuringFade.before, liveDuringFade);
    allPass &= ok("worldFrozen() is false during the fade", !liveDuringFade.worldFrozen, liveDuringFade);
    allPass &= ok("a hazard during the fade doesn't cost a life -- WIN_INVULN is still covering it", liveDuringFade.livesAfter === liveDuringFade.livesBefore, liveDuringFade);

    // --- Run the fade out: #letters gets "gone", still no life lost. ---
    const resumed = await evaluate(session, `
      (() => {
        while (fadeT > 0.02) update(0.016);
        update(0.05);   // cross the 0 boundary
        return { fadeT, hasGoneClass: byId("letters").classList.contains("letters--gone") };
      })()
    `);
    allPass &= ok("fadeT reaches exactly 0 and #letters gets the gone class", resumed.fadeT === 0 && resumed.hasGoneClass, resumed);

    // --- Once WIN_INVULN itself has actually run out (well past the fade,
    // since it decays independently), hazards are live and lethal again. ---
    const afterInvulnExpires = await evaluate(session, `
      (() => {
        while (invuln > 0.02) update(0.016);
        update(0.05);
        const livesBefore = lives;
        spawnEntity(ENTITY_TYPE.COW, travelled + 0.05, 0);
        update(0.016);
        return { invuln, livesBefore, livesAfter: lives };
      })()
    `);
    allPass &= ok("collisions are lethal again once WIN_INVULN has fully decayed", afterInvulnExpires.livesAfter < afterInvulnExpires.livesBefore, afterInvulnExpires);

    // --- Repro of the old stampede-era report: the last letter lands while
    // Season Pass's own music is playing. The collect sound must layer over
    // it without cutting it. ---
    const seasonPassOverlap = await evaluate(session, `
      (() => {
        reset(); state = "play"; lane = 0; laneA = 0;
        seasonPassT = 5; seasonPassMusicPlaying = true;   // mid-effect, well past SEASONPASS_OUTRO_DUR
        gotLetters = WORD.length - 1; shownLetters = WORD.length - 1;
        const e = spawnEntity(ENTITY_TYPE.LETTER, travelled + 0.05, 0);
        e.gi = gotLetters;
        const stopsBefore = window.__musicStops.length;
        update(0.016);   // grab
        for (let i = 0; i < 60 && fadeT < 0; i++) update(0.016);   // flight to landing
        const stoppedOnLanding = window.__musicStops.length > stopsBefore;
        return { stoppedOnLanding, seasonPassStillActive: seasonPassT > 0 };
      })()
    `);
    allPass &= ok("Season Pass's music is left running when the collect sound starts", !seasonPassOverlap.stoppedOnLanding, seasonPassOverlap);
    allPass &= ok("Season Pass's own effect is unaffected by the fade (never frozen)", seasonPassOverlap.seasonPassStillActive, seasonPassOverlap);

    const exceptions = await evaluate(session, `window.__caughtExceptions || []`);
    allPass &= ok("no page exceptions", exceptions.length === 0, exceptions);

    console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
