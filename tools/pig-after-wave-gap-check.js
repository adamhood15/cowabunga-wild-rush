#!/usr/bin/env node
// Verifies the wave->pig spacing rule (see PIG_AFTER_WAVE_MIN_GAP in
// index.html, next to JUMP_DUR/DUCK_DUR): a ENTITY_TYPE.PIG must never spawn close
// enough after a ENTITY_TYPE.WAVE that a rider who jumped the wave has no time to
// land AND duck before the pig's own hit-window starts. tuck() refuses to
// fire while jumpT >= 0, so this only matters wave -> pig, never the
// reverse (jump() has no such gate and cancels an active duck outright).
//
// Two checks:
//   1. Statistical: force spawn() through thousands of iterations across the
//      whole speed range (including the Speed Boost / tunnel boost ceiling)
//      and assert every WAVE -> PIG pair in the generated ents list is at
//      least PIG_AFTER_WAVE_MIN_GAP apart in z.
//   2. Physical: place a WAVE and a PIG exactly PIG_AFTER_WAVE_MIN_GAP apart
//      at max boosted speed, drive update() frame by frame with a scripted
//      "jump as late as legally safe, then duck the instant landing allows"
//      rider, and confirm neither hazard lands a hit.
//
// node tools/pig-after-wave-gap-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SKIP_LOADER = `dismissLoader();`;
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

    await evaluate(session, `${SEED_RIDER}${SKIP_LOADER}start(); lane = 0; laneA = 0;`);

    // 1. Statistical sweep of spawn() across the full speed range, including
    // the boosted ceiling PIG_AFTER_WAVE_MIN_GAP is sized against.
    const sweep = await evaluate(session, `
      (() => {
        const violations = [];
        let checked = 0, waveCount = 0, pigCount = 0;
        for (const testSpeed of [CONFIG.startSpeed, CONFIG.maxSpeed, CONFIG.maxSpeed * BOOST_SUPER_MULT]) {
          ents = []; travelled = 0; nextZ = 1; lastTunZ = -1e9; lastWaveZ = -1e9;
          speed = testSpeed; metres = 1200;   // past the r<0.51/hard>0.45 tunnel gates
          // spawn()'s own while loop only fills to travelled+DRAW_FAR once;
          // walk travelled forward to the horizon it just built and call
          // again, same as update() does one frame at a time, to build a
          // long track instead of a single DRAW_FAR-wide window.
          for (let i = 0; i < 4000; i++){
            travelled = Math.max(travelled, nextZ - DRAW_FAR + 1);
            spawn();
          }
          const hazards = ents.filter(e => e.t === ENTITY_TYPE.WAVE || e.t === ENTITY_TYPE.PIG)
                               .sort((a, b) => a.z - b.z);
          waveCount += hazards.filter(e => e.t === ENTITY_TYPE.WAVE).length;
          pigCount += hazards.filter(e => e.t === ENTITY_TYPE.PIG).length;
          for (let i = 0; i < hazards.length - 1; i++){
            checked++;
            if (hazards[i].t === ENTITY_TYPE.WAVE && hazards[i+1].t === ENTITY_TYPE.PIG){
              const gap = hazards[i+1].z - hazards[i].z;
              if (gap < PIG_AFTER_WAVE_MIN_GAP - 1e-9){
                violations.push({ speed: testSpeed, gap, need: PIG_AFTER_WAVE_MIN_GAP });
              }
            }
          }
        }
        return { checked, waveCount, pigCount, violations: violations.slice(0, 5),
                  violationCount: violations.length, PIG_AFTER_WAVE_MIN_GAP };
      })()
    `);

    // 2. Physical replay: WAVE then PIG exactly at the enforced minimum gap,
    // at the fastest speed a live (non-Season-Pass) rider can hit. Script a
    // rider who jumps as LATE as still-safe for the wave, then ducks the
    // instant landing allows it -- the worst-case-but-legal play the gap is
    // sized to just barely permit.
    const physical = await evaluate(session, `
      (() => {
        // Same scripted rider (jump the latest instant still safe for the
        // wave, duck the instant tuck() is legally available after landing)
        // run at two gaps: exactly PIG_AFTER_WAVE_MIN_GAP (must survive) and
        // clearly below it (must NOT survive) -- proves the constant is
        // actually the tight bound, not just a conservative overshoot.
        function runScenario(gap){
          speed = CONFIG.maxSpeed * BOOST_SUPER_MULT;
          travelled = 100; ents = []; lives = CONFIG.lives; invuln = 0;
          jumpT = -1; tuckT = 0; hurtT = 0; dieT = 0;
          const waveZ = travelled + 5;
          const pigZ = waveZ + gap;
          const wave = spawnEntity(ENTITY_TYPE.WAVE, waveZ, 0, 3);
          const pig = spawnEntity(ENTITY_TYPE.PIG, pigZ, 0, 3);
          const dt = 1/240;   // fine-grained to avoid frame-boundary artifacts
          let jumped = false, duckedAfterLanding = false;
          const livesStart = lives;
          // The latest jump-start that still keeps the rider "airborne" (lift
          // > 0.28) through the wave's trailing edge -- t_upper, the same
          // quantity PIG_AFTER_WAVE_MIN_GAP's comment derives via
          // AIR_T_LOWER's symmetry (t_upper = JUMP_DUR - AIR_T_LOWER), not
          // JUMP_DUR itself.
          const tUpper = JUMP_DUR - AIR_T_LOWER;
          for (let i = 0; i < 20000 && travelled < pigZ + 3; i++){
            if (!jumped && travelled >= waveZ + 1.2 - tUpper * speed){
              jump(); jumped = true;
            }
            if (jumped && jumpT < 0 && !duckedAfterLanding){
              tuck(); duckedAfterLanding = true;
            }
            update(dt);
          }
          return { waveZ, pigZ, gap, livesLost: livesStart - lives,
                    pigTriggered: pig.triggered === true };
        }
        // The pure zero-reaction-time physics bound (no PIG_REACT slack) --
        // the actual floor a perfect player needs. PIG_AFTER_WAVE_MIN_GAP
        // adds PIG_REACT*speed of real margin on top of this, so a gap only
        // slightly below the SHIPPED constant still has slack left in it;
        // to prove the bound is genuinely tight, test below THIS instead.
        const testSpeed = CONFIG.maxSpeed * BOOST_SUPER_MULT;
        const zeroReactBound = 1.7 + AIR_T_LOWER * testSpeed;
        return {
          atMinGap: runScenario(PIG_AFTER_WAVE_MIN_GAP),
          belowZeroReactBound: runScenario(zeroReactBound - 0.3),
        };
      })()
    `);

    const ok = sweep.violationCount === 0
      && physical.atMinGap.livesLost === 0
      && physical.belowZeroReactBound.livesLost === 1;
    console.log(JSON.stringify({ sweep, physical, pageExceptions }, null, 2));
    console.log(ok ? "PASS" : "FAIL");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
