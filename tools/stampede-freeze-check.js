#!/usr/bin/env node
// Verifies the STAMPEDE letters' run-off freeze over the real DevTools
// protocol: landing the 8th letter should pause the world (travel, spawns,
// collisions, every other power-up's own clock hold still) for STAMPEDE_DUR
// while #letters.run plays and the stampede sting sounds, with a slight
// screen shake, then resume cleanly once stampedeT runs out. Shares the same
// freezeWorld()/worldFrozen() machinery as Season Pass's reveal/outro and the
// extra-life chomp (see index.html's update()) -- this only checks the
// stampede-specific call site, not the shared helper's other callers.
//
// Also verifies runStampede() cuts whatever music is on the channel (Adam's
// report: Season Pass's music kept playing under the stampede sting when the
// last letter landed while it was active) and that the freeze's own onEnd
// hands the channel back to the right track -- "seasonPass" if that's what
// was playing, "ride" otherwise -- once the run-off ends.
//
// node tools/stampede-freeze-check.js

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
      // Fast-forward through the first 7 letters -- only the 8th's landing
      // is under test here.
      gotLetters = WORD.length - 1;
      shownLetters = WORD.length - 1;
    `);

    // --- Grab the 8th letter: gotLetters advances, but the freeze (stampedeT)
    // doesn't start yet -- it only begins once the flyer LANDS in the HUD. ---
    const grabbed = await evaluate(session, `
      (() => {
        const e = add(T.LETTER, travelled + 0.05, 0);
        e.gi = gotLetters;
        update(0.016);
        return { gotLetters, shownLetters, stampedeT, flyersLen: flyers.length, invuln };
      })()
    `);
    allPass &= ok("grabbing the 8th letter advances gotLetters, not yet the freeze", grabbed.gotLetters === 8 && grabbed.stampedeT === -1 && grabbed.flyersLen === 1, grabbed);

    // --- Run the flight out to FLY_LAND: freeze starts, run-off sound/class fire ---
    const landed = await evaluate(session, `
      (() => {
        window.__stampedeSounds = 0;
        const orig = Sound.stampede.bind(Sound);
        Sound.stampede = function(){ window.__stampedeSounds++; return orig(); };
        const stopsBefore = window.__musicStops.length;
        for (let i = 0; i < 60 && stampedeT < 0; i++) update(0.016);
        return {
          shownLetters, stampedeT, STAMPEDE_DUR,
          hasRunClass: $("letters").classList.contains("run"),
          stampedeSounds: window.__stampedeSounds,
          musicStoppedOnLanding: window.__musicStops.length > stopsBefore,
        };
      })()
    `);
    allPass &= ok("landing the flyer starts the freeze at STAMPEDE_DUR and the run-off", landed.shownLetters === 8 && landed.stampedeT > landed.STAMPEDE_DUR - 0.1 && landed.hasRunClass && landed.stampedeSounds === 1, landed);
    allPass &= ok("the ride music playing underneath is cut when the run-off starts", landed.musicStoppedOnLanding, landed);

    // --- The 8th letter's own flyer is mid-flight (~t=0.85-0.9) right when the
    // freeze starts, not freshly spawned -- it must be let finish settling into
    // its HUD slot within a handful of frames rather than hanging there for the
    // whole run-off (Adam's report: the floating "E" stuck around). ---
    const flyerSettles = await evaluate(session, `
      (() => {
        const flyersRightAfterLanding = flyers.length;
        for (let i = 0; i < 20; i++) update(0.016);   // ~0.32s, still frozen (stampedeT is huge)
        return { flyersRightAfterLanding, flyersAfterSettling: flyers.length, stampedeT };
      })()
    `);
    allPass &= ok("the landed letter's flyer settles into its HUD slot and disappears instead of hanging as a ghost", flyerSettles.flyersRightAfterLanding === 1 && flyerSettles.flyersAfterSettling === 0, flyerSettles);

    // --- World is frozen: travelled/speed hold, shake is set, no collisions ---
    const frozen = await evaluate(session, `
      (() => {
        const before = travelled;
        const livesBefore = lives;
        add(T.COW, travelled + 0.05, 0);   // would be in the hit window if collisions ran
        for (let i = 0; i < 60; i++) update(0.016);   // ~0.96s, well inside the 8.1s run-off
        return { before, after: travelled, livesBefore, livesAfter: lives, stampedeT, shake, state };
      })()
    `);
    allPass &= ok("travelled does not advance during the run-off freeze", frozen.after === frozen.before, frozen);
    allPass &= ok("no life lost during the freeze (collision loop doesn't run)", frozen.livesAfter === frozen.livesBefore, frozen);
    allPass &= ok("shake is set for the herd-underfoot effect", frozen.shake > 0 && frozen.shake < 1, frozen);
    allPass &= ok("still mid-freeze after ~1s of an 8.1s run-off", frozen.stampedeT > 6.5, frozen);

    // --- Rider flash isn't stuck: drawRider() draws every sampled frame despite invuln>0 ---
    const flashDuringFreeze = await evaluate(session, `
      (() => { window.__saves = 0; const orig = ctx.save.bind(ctx);
        ctx.save = function(){ window.__saves++; return orig(); };
        const drawsAt = [];
        for (let i = 0; i < 24; i++){ window.__saves = 0; drawRider(); drawsAt.push(window.__saves); runT += 1/12; }
        ctx.save = orig;
        return { drawsAt, allDrawn: drawsAt.every(n => n > 0), invuln, worldFrozen: worldFrozen() };
      })()
    `);
    allPass &= ok("rider is drawn every frame through the freeze (flash suppressed)", flashDuringFreeze.allDrawn && flashDuringFreeze.invuln > 0 && flashDuringFreeze.worldFrozen, flashDuringFreeze);

    // --- Run the freeze out: #letters gets "gone", world resumes, no bonus invuln ---
    const resumed = await evaluate(session, `
      (() => {
        while (stampedeT > 0.02) update(0.016);
        update(0.05);   // cross the 0 boundary
        return {
          stampedeT, hasGoneClass: $("letters").classList.contains("gone"), invuln, WIN_INVULN,
          lastMusicStart: window.__musicStarts[window.__musicStarts.length - 1],
        };
      })()
    `);
    allPass &= ok("stampedeT reaches exactly 0 and #letters gets the gone class", resumed.stampedeT === 0 && resumed.hasGoneClass, resumed);
    allPass &= ok("the channel hands back to ride music once the run-off ends", resumed.lastMusicStart === "ride", resumed);
    // invuln is frozen (not decaying) for the whole run-off, same as every other
    // timer -- so up to its pre-freeze remainder (bounded by WIN_INVULN, the
    // flight-to-landing grace) can still be sitting on it the instant the freeze
    // ends. That's expected and small; it must NOT still be anywhere near
    // WIN_INVULN's full amount, which would mean STAMPEDE_DUR itself leaked back
    // into the grant (the regression WIN_INVULN was shrunk to avoid -- see its
    // comment in index.html). Real decay is checked below via live collisions.
    allPass &= ok("no bonus invincibility re-inflated by the freeze", resumed.invuln < resumed.WIN_INVULN, resumed);

    // --- World resumes: travelled advances again, collisions are live again ---
    const afterResume = await evaluate(session, `
      (() => {
        const before = travelled;
        const livesBefore = lives;
        for (let i = 0; i < 30; i++) update(0.016);
        add(T.COW, travelled + 0.05, 0);
        update(0.016);
        return { before, after: travelled, livesBefore, livesAfter: lives };
      })()
    `);
    allPass &= ok("travelled advances once the run-off ends", afterResume.after > afterResume.before, afterResume);
    allPass &= ok("collisions are live again once the run-off ends", afterResume.livesAfter < afterResume.livesBefore, afterResume);

    // --- Repro of Adam's report: the 8th letter lands while Season Pass's
    // own music is playing (mid-effect, not the intro/outro freeze). The
    // stampede sting must cut it, and the freeze must hand the channel back
    // to "seasonPass" (its own effect resumes right where it left off, same
    // frozen seasonPassT), not to "ride". ---
    const seasonPassOverlap = await evaluate(session, `
      (() => {
        reset(); state = "play"; lane = 0; laneA = 0;
        seasonPassT = 5; seasonPassMusicPlaying = true;   // mid-effect, well past SEASONPASS_OUTRO_DUR
        gotLetters = WORD.length - 1; shownLetters = WORD.length - 1;
        const e = add(T.LETTER, travelled + 0.05, 0);
        e.gi = gotLetters;
        const stopsBefore = window.__musicStops.length;
        update(0.016);   // grab -- plays out under normal rules, Season Pass is mid-effect, not frozen
        for (let i = 0; i < 60 && stampedeT < 0; i++) update(0.016);   // flight to landing
        const stoppedOnLanding = window.__musicStops.length > stopsBefore;
        while (stampedeT > 0.02) update(0.016);
        update(0.05);
        return {
          stoppedOnLanding,
          lastMusicStart: window.__musicStarts[window.__musicStarts.length - 1],
          seasonPassTStillActive: seasonPassT > 0,
        };
      })()
    `);
    allPass &= ok("Season Pass's music is cut when the stampede sting starts", seasonPassOverlap.stoppedOnLanding, seasonPassOverlap);
    allPass &= ok("the channel hands back to Season Pass's music, not ride, once the run-off ends", seasonPassOverlap.lastMusicStart === "seasonPass" && seasonPassOverlap.seasonPassTStillActive, seasonPassOverlap);

    const exceptions = await evaluate(session, `window.__caughtExceptions || []`);
    allPass &= ok("no page exceptions", exceptions.length === 0, exceptions);

    console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
