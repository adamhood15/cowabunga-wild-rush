#!/usr/bin/env node
// Checks the metric tools/sprite-size-audit.js does NOT check: whether the
// COW'S TUBE reads as the same physical size across every cowabunga-sprites
// animation (idle, eat, move, duck, hurt, die, speed-boost, season-pass) --
// as opposed to raw opaque-pixel apparent area (which conflates decoration
// -- sparkle bursts, motion lines, splash bloom -- with the tube's own
// size). Built 2026-09-17 after Adam reported the Season Pass and Speed
// Boost rider animations visibly shrinking/growing frame to frame despite
// both passing sprite-size-audit.js's apparent-area threshold.
//
// Revised 2026-09-17 (Adam): rather than each animation only needing to be
// self-consistent against its OWN mean (the original version of this tool),
// EVERY frame of EVERY cowabunga animation must render its tube at the same
// size as cowabunga-idle_01.png's tube specifically -- a single, fixed
// baseline across the whole cast, not a per-set floating target. idle_01 is
// not currently in the live idle loop (see index.html's "idle_01 dropped"
// comment -- its CROP sat off-centre, unrelated to its tube's SIZE, which is
// why it's still fair to use as the size reference), so it's loaded here by
// its own file path rather than through the page's IMG cache.
//
// THE METRIC: apparentTubeWidth = k * tubeRingPxWidth, where:
//   - tubeRingPxWidth is measured directly off that specific frame's own
//     alpha/color data (a real, independent pixel measurement -- NOT taken
//     from that frame's own registration constant, since the whole point is
//     to check whether the registration constant is telling the truth).
//   - k is the EXACT per-pixel scale factor drawRider()'s real draw call
//     computes for that frame (reusing each set's live formula, read from
//     index.html's own constants) -- so this reports what the game ACTUALLY
//     puts on screen, not a hypothetical.
// Every frame's apparentTubeWidth is compared against
// cowabunga-idle_01.png's own apparentTubeWidth (computed the same way, via
// the idle/eat/move own-aspect formula), not against its own set's mean.
//
// TUBE-RING COLOR MASKS (reused verbatim from the existing per-set measure
// tools -- see each one's own header comment for why these specific
// thresholds/strategies were chosen):
//   - "teal" (idle/eat/move/duck/hurt/die): b>110 && g>70 && b>=g-10 &&
//     r<90 && (g-r)>40, keeping the UNION of connected components wider
//     than 35% of the frame (tools/duck-frame-measure.js /
//     hurt-frame-measure.js -- rejoins the ring where a crossed arm splits
//     it into arcs, without fusing in disconnected splash droplets).
//   - "tealBanded" (speed-boost): same teal test, restricted to the
//     0.45h-0.85h row band (tools/speed-frame-measure.js -- the only
//     approach that survives this art's splash bloom).
//   - "blue" (season-pass): r<80 && b>150 && (b-r)>90 && g>80 && g<220 &&
//     b>=g-10, keeping the single LARGEST connected component
//     (tools/season-pass-measure.js -- discards the held card's own blue
//     logo, a separate small blob).
//
// node tools/rider-visual-size-check.js
// node tools/rider-visual-size-check.js --threshold 0.05

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const thresholdArg = process.argv.indexOf("--threshold");
// Tightened 2026-09-17 (Adam: "closer to pixel-perfect... doesn't need to be
// exact") from an initial 0.05 -- 0.02 comfortably clears the small
// systematic offset every correctly tube-pinned frame still carries (each
// whole SET sits ~0.6-0.8% off the idle_01 baseline, not frame to frame --
// see IDLE_TUBE_W's own comment for why: it's measured off cowabunga-
// idle_02.png, not idle_01, and the two frames' own tubes aren't identical),
// while still catching a real per-frame outlier.
const THRESHOLD = thresholdArg >= 0 ? parseFloat(process.argv[thresholdArg + 1]) : 0.02;

// ---------------------------------------------------------------------
// Every cowabunga-sprites frame this check covers, grouped by animation.
// Paths are read directly off disk (not via ART/IMG) so idle_01 -- not
// currently wired into the live idle loop -- can be measured the same way
// as every frame that IS live.
// ---------------------------------------------------------------------
const BASELINE = { key: "idle_01", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_01.png" };

const SETS = [
  {
    name: "IDLE",
    kind: "ownAspect",
    mask: "teal",
    frames: [
      { key: "idle_02", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_02.png" },
      { key: "idle_03", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_03.png" },
    ],
  },
  {
    name: "EAT",
    kind: "ownAspect",
    mask: "teal",
    frames: [
      { key: "eat_01", src: "assets/sprites/typhoon-sprites/extra-life/extra-life_01.png" },
      { key: "eat_02", src: "assets/sprites/typhoon-sprites/extra-life/extra-life_02.png" },
      { key: "eat_03", src: "assets/sprites/typhoon-sprites/extra-life/extra-life_03.png" },
      { key: "eat_04", src: "assets/sprites/typhoon-sprites/extra-life/extra-life_04.png" },
    ],
  },
  {
    name: "MOVE",
    kind: "idlePinned",
    mask: "teal",
    regName: "MOVE_REG",
    regKeys: ["-1", "1"],   // MOVE_REG is keyed like MOVE_KEY (moveDir), not a plain array
    frames: [
      { key: "move_left",  src: "assets/sprites/cowabunga-sprites/lean/cowabunga-move-left.png" },
      { key: "move_right", src: "assets/sprites/cowabunga-sprites/lean/cowabunga-move-right.png" },
    ],
  },
  {
    name: "DUCK",
    kind: "idlePinned",
    mask: "teal",
    regName: "DUCK_REG",
    frames: [
      { key: "duck_01", src: "assets/sprites/cowabunga-sprites/duck/duck_01.png" },
      { key: "duck_02", src: "assets/sprites/cowabunga-sprites/duck/duck_02.png" },
      { key: "duck_03", src: "assets/sprites/cowabunga-sprites/duck/duck_03.png" },
    ],
  },
  {
    name: "HURT",
    kind: "idlePinned",
    mask: "teal",
    regName: "HURT_REG",
    frames: [
      { key: "hurt_01", src: "assets/sprites/cowabunga-sprites/hurt/hurt_01.png" },
      { key: "hurt_02", src: "assets/sprites/cowabunga-sprites/hurt/hurt_02.png" },
      { key: "hurt_03", src: "assets/sprites/cowabunga-sprites/hurt/hurt_03.png" },
    ],
  },
  {
    name: "DIE",
    kind: "idlePinned",
    mask: "teal",
    regName: "DIE_REG",
    frames: [
      { key: "die_01", src: "assets/sprites/cowabunga-sprites/die/die_01.png" },
      { key: "die_02", src: "assets/sprites/cowabunga-sprites/die/die_02.png" },
      { key: "die_03", src: "assets/sprites/cowabunga-sprites/die/die_03.png" },
    ],
  },
  // SPEED_BOOST deliberately excluded (2026-09-17): Adam's explicit call
  // was to pull these frames in at their own extracted opaque-bbox sizes
  // and NOT standardize them against idle_01 or against each other (see
  // SPEED_BBOX's own comment in index.html) -- there is no "SPEED_REG"
  // tw/cx/by anymore for this check's idlePinned formula to read, and
  // baselining this set would just flag success as failure by design.
  {
    name: "SEASON_PASS",
    kind: "seasonPass",
    mask: "blue",
    regName: "SEASONPASS_REG",
    frames: Array.from({ length: 11 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return { key: "season-pass_" + n, src: "assets/sprites/cowabunga-sprites/season-pass/season-pass_" + n + ".png" };
    }),
  },
];

// In-page helper: loads an image by URL, applies the named mask strategy,
// returns the tube ring's own pixel bbox plus the image's native size.
const MEASURE_TUBE_HELPER = `
  async function loadImg(src){
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }
  function pixelData(img){
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, img.width, img.height).data;
  }
  const MASKS = {
    teal:       { test: (r,g,b) => b > 110 && g > 70 && b >= g - 10 && r < 90 && (g - r) > 40 },
    tealBanded: { test: (r,g,b) => b > 110 && g > 70 && b >= g - 10 && r < 90 && (g - r) > 40, band: [0.45, 0.85] },
    blue:       { test: (r,g,b) => r < 80 && b > 150 && (b - r) > 90 && g > 80 && g < 220 && b >= g - 10 },
  };
  function measureTubeRing(img, maskName){
    const data = pixelData(img);
    const w = img.width, h = img.height;
    const { test, band } = MASKS[maskName];
    const isMatchAt = (x, y) => {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] < 16) return false;
      return test(data[idx], data[idx + 1], data[idx + 2]);
    };

    if (band){
      // tealBanded (speed-boost): restrict the scan to the row band the
      // ring sits in on every frame -- a plain bbox within that band, no
      // component filtering needed (splash there is white/foam, fails the
      // teal test outright).
      const yLo = Math.floor(band[0] * h), yHi = Math.floor(band[1] * h);
      let minX = w, maxX = -1;
      for (let y = yLo; y < yHi; y++)
        for (let x = 0; x < w; x++)
          if (isMatchAt(x, y)){ if (x < minX) minX = x; if (x > maxX) maxX = x; }
      return { minX, maxX, imgW: w, imgH: h };
    }

    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (isMatchAt(x, y)) mask[y * w + x] = 1;

    // Flood fill (4-connectivity, iterative stack) into components.
    const labels = new Int32Array(w * h).fill(-1);
    const components = [];
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        const p = y * w + x;
        if (labels[p] !== -1 || !mask[p]) continue;
        const stack = [p];
        labels[p] = components.length;
        let count = 0, cMinX = x, cMaxX = x;
        while (stack.length){
          const cur = stack.pop();
          count++;
          const cx = cur % w, cy = (cur / w) | 0;
          if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
          const neighbors = [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]];
          for (const [nx, ny] of neighbors){
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const np = ny * w + nx;
            if (labels[np] !== -1 || !mask[np]) continue;
            labels[np] = components.length;
            stack.push(np);
          }
        }
        components.push({ count, cMinX, cMaxX });
      }
    }
    if (maskName === "blue"){
      // season-pass: single largest component (discards the held card's
      // own separate blue logo patch).
      let best = null;
      for (const c of components) if (!best || c.count > best.count) best = c;
      return { minX: best.cMinX, maxX: best.cMaxX, imgW: w, imgH: h };
    }
    // teal (idle/eat/move/duck/hurt/die): union of every component wider
    // than 35% of the frame -- rejoins the ring where a crossed arm splits
    // it into arcs without fusing in a disconnected splash droplet.
    const pieces = components.filter(c => (c.cMaxX - c.cMinX) > 0.35 * w);
    let minX = w, maxX = -1;
    for (const c of pieces){ if (c.cMinX < minX) minX = c.cMinX; if (c.cMaxX > maxX) maxX = c.cMaxX; }
    return { minX, maxX, imgW: w, imgH: h };
  }
`;

async function measureBaseline(session) {
  const result = await evaluate(session, `
    (async () => {
      ${MEASURE_TUBE_HELPER}
      const img = await loadImg(${JSON.stringify(BASELINE.src)});
      const ring = measureTubeRing(img, "teal");
      const tubePxWidth = ring.maxX - ring.minX + 1;
      const k = 1 / ring.imgH;   // own-aspect formula: h=1 world unit, k = h/img.height
      return { key: ${JSON.stringify(BASELINE.key)}, imgW: ring.imgW, imgH: ring.imgH, tubePxWidth, k, apparentTubeWidth: k * tubePxWidth };
    })()
  `, { awaitPromise: true });
  return result;
}

async function measureSet(session, set) {
  let regJson = "null";
  if (set.regName) regJson = JSON.stringify(await evaluate(session, set.regName));

  const kFormulaBySet = {
    // Own-aspect (idle/eat/move): h=1 world unit, k = h/img.height.
    ownAspect: `1 / ring.imgH`,
    // Tube-pinned against IDLE's own on-screen tube (IDLE_TUBE_W, cowIdle2's
    // ring) -- same shape as drawRider()'s duck/hurt/die/speed/move branch.
    // regKey lets MOVE_REG (keyed like MOVE_KEY -- "-1"/"1" -- not a plain
    // array like every other REG here) share this same formula.
    idlePinned: `(() => {
      const R = REG[regKey];
      const imW = 1 * (cowIdle2W / cowIdle2H);
      const dw = (imW * IDLE_TUBE_W) / R.tw;
      return dw / ring.imgW;
    })()`,
    // Still tube-pinned against the OLD typhoon-rider.png tube (RIDER_TUBE_W)
    // -- Season Pass hasn't been migrated to the IDLE_TUBE_W formula yet.
    seasonPass: `(() => {
      const R = REG[i];
      const w = 1 * (riderW / riderH);
      const dw = (w * RIDER_TUBE_W) / R.tw;
      return dw / ring.imgW;
    })()`,
  };

  const result = await evaluate(session, `
    (async () => {
      ${MEASURE_TUBE_HELPER}
      const REG = ${regJson};
      const cowIdle2W = IMG.cowIdle2.width, cowIdle2H = IMG.cowIdle2.height;
      const riderW = IMG.rider.width, riderH = IMG.rider.height;
      const frames = ${JSON.stringify(set.frames)};
      const regKeys = ${JSON.stringify(set.regKeys || null)};
      const out = [];
      for (let i = 0; i < frames.length; i++){
        const { key, src } = frames[i];
        const regKey = regKeys ? regKeys[i] : i;
        const img = await loadImg(src);
        const ring = measureTubeRing(img, ${JSON.stringify(set.mask)});
        const tubePxWidth = ring.maxX - ring.minX + 1;
        const k = ${kFormulaBySet[set.kind]};
        out.push({ key, imgW: ring.imgW, imgH: ring.imgH, tubePxWidth, k, apparentTubeWidth: k * tubePxWidth });
      }
      return out;
    })()
  `, { awaitPromise: true });
  return result;
}

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 400));
    await evaluate(session, `
      (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline){
          const keys = Object.keys(ART);
          if (keys.every(k => IMG[k] && IMG[k].complete && IMG[k].naturalWidth > 0)) return;
          await new Promise(r => setTimeout(r, 100));
        }
      })()
    `, { awaitPromise: true });

    const baseline = await measureBaseline(session);
    console.log("=== BASELINE: " + baseline.key + " ===");
    console.log(
      "  imgSize=" + baseline.imgW + "x" + baseline.imgH +
      " tubePxWidth=" + baseline.tubePxWidth +
      " k=" + baseline.k.toFixed(6) +
      " apparentTubeWidth=" + baseline.apparentTubeWidth.toFixed(5) + "  <- every frame below is compared to this"
    );

    let anyFlag = false;
    for (const set of SETS) {
      const frames = await measureSet(session, set);
      console.log("\n=== " + set.name + " (vs " + baseline.key + " baseline) ===");
      const flagged = [];
      for (const f of frames) {
        const dev = (f.apparentTubeWidth - baseline.apparentTubeWidth) / baseline.apparentTubeWidth;
        if (Math.abs(dev) > THRESHOLD) flagged.push(f.key);
        console.log(
          "  " + f.key.padEnd(14) +
          " tubePxWidth=" + String(f.tubePxWidth).padEnd(5) +
          " k=" + f.k.toFixed(6) +
          " apparentTubeWidth=" + f.apparentTubeWidth.toFixed(5) +
          " dev=" + (dev >= 0 ? "+" : "") + (dev * 100).toFixed(1) + "%"
        );
      }
      if (flagged.length) { anyFlag = true; console.log("  FLAGGED (>±" + (THRESHOLD * 100).toFixed(0) + "% vs baseline): " + flagged.join(", ")); }
      else console.log("  All frames within tolerance of baseline.");
    }

    process.exitCode = anyFlag ? 1 : 0; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
