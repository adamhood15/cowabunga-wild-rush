#!/usr/bin/env node
// Sprite/power-up/letter size audit (see TODOLIST.md "Sprite animation
// audit" and "ensure that letters and power-ups are uniform in the size
// that they render, be sure to account for glow effects"): checks whether
// every registered sprite group -- rider animation frames, power-up icons,
// and collectible letters -- renders at a CONSISTENT VISUAL SIZE frame to
// frame / sprite to sprite -- not consistent PNG pixel dimensions, which is
// a red herring (the season-pass frames alone range from 436x481 to
// 560x517, and whirlpool.png vs season-pass.png aren't remotely the same
// shape or padding -- both are fine on their own).
//
// The real invariant is what the draw call actually puts on screen, in
// every case a single uniform per-sprite scale factor k (drawImage never
// distorts aspect, so dw/img.width == dh/img.height always) applied to that
// sprite's own opaque (non-transparent) pixel footprint -- not raw bounding
// box, which foreshortening/cropping can shrink or grow independent of the
// character's/icon's actual size.
//
//   RIDER ANIMATION FRAMES (drawRider()):
//     Tube-registered sets (DUCK_REG/HURT_REG/DIE_REG/EAT_REG/
//     SEASONPASS_REG/MOVE_REG): dw = (w * RIDER_TUBE_W) / R.tw;
//     k = dw / img.width.
//     Area-registered sets (FLIP_REG/SPIN_REG/SPEED_REG):
//     k = (h / img.height) * R.s, chosen by construction so apparent area
//     should already come out flat -- this audit is what proves that,
//     rather than assuming the comment claiming it is true.
//     Metric: k^2 * opaque-pixel-count of the whole native PNG.
//
//   POWER-UP ICONS (drawEntInner(), fastPass/souvenir/extraLife/whirlpool/
//   seasonPass): dh = H*s*grow, dw = dh*(img.width/img.height) -- the whole
//   native PNG is drawn, so k = dh/img.height.
//
//   COLLECTIBLE LETTERS (drawEntInner(), lt1-lt8): dh = h,
//   dw = h*(WORD_SRC.w[idx]/WORD_SRC.h), cropped from the source at
//   WORD_SRC.y/WORD_SRC.h, so k = h/WORD_SRC.h. Opaque count is over that
//   same crop region, not the whole canvas.
//
//   Icon/letter glows are procedural (radial gradients / vector shapes
//   keyed off h at draw time), not baked into the PNGs, so their reach
//   can't be measured from pixels -- this tool reports each one's own
//   outer-radius formula (as a multiple of its icon's h) read directly from
//   the constants each glow function draws with, so the reach ratios can be
//   compared the same way the icon areas are.
//
// node tools/sprite-size-audit.js
// node tools/sprite-size-audit.js --threshold 0.06   (flag >6% deviation, rider frames only)

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const thresholdArg = process.argv.indexOf("--threshold");
const THRESHOLD = thresholdArg >= 0 ? parseFloat(process.argv[thresholdArg + 1]) : 0.08;

// Shared measurement helper (in-page): draws the given source region into a
// scratch canvas and reads back alpha data -- opaque pixel COUNT (the true
// on-screen silhouette area once scaled by k) plus the opaque bounding box
// (needed for footprintArea, see the letters/icons section below). Used for
// both the rider frames (whole-PNG region) and icons/letters (whole-PNG or
// cropped region).
const MEASURE_HELPER = `
  function measure(img, x0, y0, w0, h0){
    const c = document.createElement("canvas");
    c.width = w0; c.height = h0;
    const cx = c.getContext("2d");
    cx.drawImage(img, x0, y0, w0, h0, 0, 0, w0, h0);
    const data = cx.getImageData(0, 0, w0, h0).data;
    let n = 0, minX = w0, maxX = -1, minY = h0, maxY = -1;
    for (let y = 0; y < h0; y++){
      for (let x = 0; x < w0; x++){
        const a = data[(y * w0 + x) * 4 + 3];
        if (a < 16) continue;
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    // bbox is inclusive of the last opaque pixel -> +1 for a true span
    const bboxW = maxX >= minX ? (maxX - minX + 1) : 0;
    const bboxH = maxY >= minY ? (maxY - minY + 1) : 0;
    return { opaquePx: n, bboxW, bboxH };
  }
`;

async function auditRiderFrames(session) {
  const result = await evaluate(session, `
    (async () => {
      ${MEASURE_HELPER}
      const h = 1, w = h * (IMG.rider.width / IMG.rider.height);

      const tubeSets = {
        DUCK_REG:       { reg: DUCK_REG,       keys: ["duck0","duck1","duck2"] },
        HURT_REG:       { reg: HURT_REG,       keys: ["hurt0","hurt1","hurt2"] },
        DIE_REG:        { reg: DIE_REG,        keys: ["die0","die1","die2"] },
        EAT_REG:        { reg: EAT_REG,        keys: ["eat0","eat1","eat2","eat3"] },
        SEASONPASS_REG: { reg: SEASONPASS_REG, keys: ["sp0","sp1","sp2","sp3","sp4","sp5","sp6","sp7","sp8"] },
        MOVE_REG:       { reg: [MOVE_REG["-1"], MOVE_REG["1"]], keys: ["mvL","mvR"] },
      };
      const areaSets = {
        FLIP_REG:  { reg: FLIP_REG,  keys: ["flip0","flip1","flip2","flip3"] },
        SPIN_REG:  { reg: SPIN_REG,  keys: ["spin0","spin1","spin2","spin3"] },
        SPEED_REG: { reg: SPEED_REG, keys: ["speed0","speed1","speed2","speed3"] },
      };

      const out = {};
      for (const [name, { reg, keys }] of Object.entries(tubeSets)){
        out[name] = keys.map((key, i) => {
          const img = IMG[key], R = reg[i];
          const dw = (w * RIDER_TUBE_W) / R.tw;
          const k = dw / img.width;
          const m = measure(img, 0, 0, img.width, img.height);
          return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                    k, apparentArea: k * k * m.opaquePx, tw: R.tw };
        });
      }
      for (const [name, { reg, keys }] of Object.entries(areaSets)){
        out[name] = keys.map((key, i) => {
          const img = IMG[key], R = reg[i];
          const k = (h / img.height) * R.s;
          const m = measure(img, 0, 0, img.width, img.height);
          return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                    k, apparentArea: k * k * m.opaquePx, s: R.s };
        });
      }
      return out;
    })()
  `, { awaitPromise: true });

  const report = {};
  let anyFlag = false;
  for (const [setName, frames] of Object.entries(result)){
    const areas = frames.map(f => f.apparentArea);
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    const rows = frames.map((f, i) => {
      const dev = (f.apparentArea - mean) / mean;
      const prev = i > 0 ? frames[i - 1].apparentArea : null;
      const stepPct = prev !== null ? (f.apparentArea - prev) / prev : null;
      return { ...f, devFromMean: dev, stepFromPrev: stepPct };
    });
    const flagged = rows.filter(r => Math.abs(r.devFromMean) > THRESHOLD);
    if (flagged.length) anyFlag = true;
    report[setName] = { mean, rows, flagged: flagged.map(r => r.key) };
  }

  console.log("=== RIDER ANIMATION FRAMES ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(anyFlag
    ? "\nFLAGGED (>±" + (THRESHOLD * 100).toFixed(0) + "% of set mean apparent area): " +
      Object.entries(report).filter(([, r]) => r.flagged.length)
        .map(([n, r]) => n + ": " + r.flagged.join(", ")).join(" | ")
    : "\nNo frame set deviates beyond threshold.");

  return anyFlag;
}

async function auditIconsAndLetters(session) {
  const result = await evaluate(session, `
    (async () => {
      ${MEASURE_HELPER}
      const icons = {
        fastPass:   { img: IMG.fastPass,   H: FASTPASS_H,   glowR: FASTPASS_GLOW_R,  glowNote: "fastPassGlow halo, 0.92-1.08x pulse" },
        souvenir:   { img: IMG.souvenir,   H: SOUVENIR_H,   glowR: SOUVENIR_GLOW_R,  glowNote: "souvenirGlow halo, 0.94-1.06x pulse" },
        extraLife:  { img: IMG.extraLife,  H: EXTRALIFE_H,  glowR: null,  glowNote: "smell lines, not a radial halo (riseH = h*1.9 vertical)" },
        whirlpool:  { img: IMG.whirlpool,  H: WHIRLPOOL_H,  glowR: WHIRLPOOL_SWIRL_R, glowNote: "whirlpoolHalo swirl, static" },
        seasonPass: { img: IMG.seasonPass, H: SEASONPASS_H, glowR: SEASONPASS_HALO_R,  glowNote: "seasonPassGlow halo (core " + SEASONPASS_CORE_R + ", rings transient to " + (SEASONPASS_RING_BASE + SEASONPASS_RING_RANGE).toFixed(2) + ")" },
      };
      const iconOut = {};
      for (const [name, { img, H, glowR, glowNote }] of Object.entries(icons)){
        const m = measure(img, 0, 0, img.width, img.height);
        const k = H / img.height;
        iconOut[name] = {
          nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
          bboxW: m.bboxW, bboxH: m.bboxH,
          H, k, apparentArea: k * k * m.opaquePx,
          footprintArea: k * k * m.bboxW * m.bboxH,
          apparentHeight: k * m.bboxH, apparentWidth: k * m.bboxW,
          glowR, glowNote,
        };
      }

      const letterOut = [];
      for (let i = 0; i < 8; i++){
        const img = IMG["lt" + (i + 1)];
        const m = measure(img, WORD_SRC.x[i], WORD_SRC.y, WORD_SRC.w[i], WORD_SRC.h);
        const k = LETTER_H / WORD_SRC.h;
        letterOut.push({
          key: "lt" + (i + 1), nativeCanvasW: img.width, nativeCanvasH: img.height,
          cropW: WORD_SRC.w[i], cropH: WORD_SRC.h, opaquePx: m.opaquePx,
          bboxW: m.bboxW, bboxH: m.bboxH,
          H: LETTER_H, k, apparentArea: k * k * m.opaquePx,
          footprintArea: k * k * m.bboxW * m.bboxH,
          apparentHeight: k * m.bboxH, apparentWidth: k * m.bboxW,
          glowR: SUN_R, glowNote: "letterSun fan, 1.0-1.14x flare (transient)",
        });
      }
      return { icons: iconOut, letters: letterOut };
    })()
  `, { awaitPromise: true });

  // footprintArea (apparent bounding-box W x H) is the metric that fairly
  // compares a sparse glyph against a solid-filled badge icon: opaque PIXEL
  // COUNT conflates "how big does this look" with "how dense/thin is this
  // shape's own linework", which is exactly why lt4 ("M") shows a +33%
  // opaquePx deviation among letters below despite being the same cap
  // height as every other letter in WORD_SRC's shared band -- M just has
  // more ink, not a bigger bounding box. footprintArea has no such bias.
  const letterFoot = result.letters.map(l => l.footprintArea);
  const letterFootMean = letterFoot.reduce((a, b) => a + b, 0) / letterFoot.length;
  const groupFootMean = (
    Object.values(result.icons).reduce((a, r) => a + r.footprintArea, 0) + letterFootMean
  ) / (Object.keys(result.icons).length + 1);   // letters counted once, as a group

  console.log("\n=== POWER-UP ICONS ===");
  for (const [name, r] of Object.entries(result.icons)){
    const devFoot = (r.footprintArea - groupFootMean) / groupFootMean;
    const devArea = (r.apparentArea - groupFootMean) / groupFootMean;   // for reference only, different metric
    console.log(
      name.padEnd(11) +
      " native=" + (r.nativeW + "x" + r.nativeH).padEnd(9) +
      " bbox=" + (r.bboxW + "x" + r.bboxH).padEnd(9) +
      " H=" + r.H.toFixed(2) +
      " apparentH=" + r.apparentHeight.toFixed(4) +
      " apparentW=" + r.apparentWidth.toFixed(4) +
      " footprintArea=" + r.footprintArea.toFixed(6) +
      " devFootprint=" + (devFoot >= 0 ? "+" : "") + (devFoot * 100).toFixed(1) + "%" +
      "  [opaqueArea=" + r.apparentArea.toFixed(4) + " devOpaqueArea=" + (devArea >= 0 ? "+" : "") + (devArea * 100).toFixed(1) + "%]" +
      " glowR=" + (r.glowR === null ? "n/a" : r.glowR) +
      "  (" + r.glowNote + ")"
    );
  }

  console.log("\n=== COLLECTIBLE LETTERS (as a group; per-letter footprint) ===");
  for (const l of result.letters){
    const dev = (l.footprintArea - letterFootMean) / letterFootMean;
    const devArea = (l.apparentArea - (result.letters.reduce((a,x)=>a+x.apparentArea,0)/result.letters.length)) / (result.letters.reduce((a,x)=>a+x.apparentArea,0)/result.letters.length);
    console.log(
      l.key.padEnd(6) +
      " crop=" + (l.cropW + "x" + l.cropH).padEnd(9) +
      " bbox=" + (l.bboxW + "x" + l.bboxH).padEnd(9) +
      " apparentH=" + l.apparentHeight.toFixed(4) +
      " apparentW=" + l.apparentWidth.toFixed(4) +
      " footprintArea=" + l.footprintArea.toFixed(6) +
      " devWithinLetters=" + (dev >= 0 ? "+" : "") + (dev * 100).toFixed(1) + "%" +
      "  [devOpaqueArea=" + (devArea >= 0 ? "+" : "") + (devArea * 100).toFixed(1) + "%]"
    );
  }
  console.log("letters group mean footprintArea = " + letterFootMean.toFixed(6));
  console.log("\noverall group mean (5 icons + letters-as-one-group) footprintArea = " + groupFootMean.toFixed(6));

  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 400));

    const riderFlagged = await auditRiderFrames(session);
    await auditIconsAndLetters(session);

    process.exitCode = riderFlagged ? 1 : 0; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
