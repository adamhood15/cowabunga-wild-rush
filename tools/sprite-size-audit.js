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
//     Tube-registered, cowabunga tube (DUCK_REG/DIE_REG/HURT_REG):
//     dw = (imW_idle * IDLE_TUBE_W) / R.tw, imW_idle = h *
//     (cowIdle2.width / cowIdle2.height); k = dw / img.width. See DUCK_REG's
//     own comment in index.html for why (RIDER_TUBE_W belongs to a
//     different, unrelated tube design). DIE_REG and HURT_REG joined
//     2026-09-14, same reasoning -- HURT_REG replaced an initial own-aspect
//     attempt that this very audit caught making the cow change apparent
//     size frame to frame (see HURT and DIE's own comment in index.html for
//     the numbers).
//     Cropped-own-aspect sets (SPEED_BBOX/SEASONPASS_BBOX): k = h / B.h,
//     dw = B.w * k, applied to just that frame's own real opaque bbox
//     (native pixels, off the alpha channel) rather than any shared
//     registration constant -- Adam's explicit call (2026-09-17 for
//     speed-boost, 2026-09-21 for season-pass): "pull the frames in at their
//     extracted sizes and not standardize the sizes at all". SPEED_BBOX
//     joined first, on its FOURTH registration attempt -- see its own
//     comment in index.html for why sqrt(area), a bbox-height pin,
//     own-aspect, and a "waist" scan (fed into the cowabunga tube-width
//     formula, which is what actually caused the "cow is huge" bug Adam
//     reported) all got it wrong first. SEASONPASS_BBOX replaced
//     SEASONPASS_REG (the old typhoon-tube-pinned scheme) the same way, once
//     the same symptom -- the cow visibly shrinking and growing through the
//     animation -- turned up there too. Because there's no shared target,
//     apparentArea below is EXPECTED to vary across each set's own frames
//     (a splash/card bloom growing the frame, not the cow) -- see
//     idlePinnedSets below for the deviation-flag caveat that applies to
//     both.
//     Area-registered sets (FLIP_REG/SPIN_REG): k = (h / IMG.rider.height) *
//     R.s, chosen by construction so apparent area should already come out
//     flat -- this audit is what proves that, rather than assuming the
//     comment claiming it is true.
//     Own-aspect sets (idle/eat/move -- the cowabunga cow-in-a-tube art,
//     drawn off its own aspect ratio rather than any registration
//     constants): k = h / img.height directly, same formula drawRider's
//     idleImg/eatImg/moveImg branch uses. These rely on every source PNG
//     being cropped tight to its own opaque bbox (0% padding) rather than a
//     measured constant -- this audit's bboxH/img.height ratio is what
//     verifies that crop, not a registration number.
//     Metric: k^2 * opaque-pixel-count of the whole native PNG.
//
//   POWER-UP ICONS (drawEntInner(), speedBoostPickup/souvenir/extraLife/whirlpool/
//   seasonPass): dh = H*s*grow, dw = dh*(img.width/img.height) -- the whole
//   native PNG is drawn, so k = dh/img.height.
//
//   COLLECTIBLE LETTERS (drawEntInner(), lt1-lt9): dh = h,
//   dw = h*(WORD_SRC.w[idx]/WORD_SRC.h[idx]), cropped from the source at
//   WORD_SRC.y[idx]/WORD_SRC.h[idx] -- per-letter, not a shared scalar, since
//   these files (unlike the old letters_0N.png set) are each cropped tight
//   to their own ink on their own differently-sized canvas -- so
//   k = h/WORD_SRC.h[idx]. Opaque count is over that same crop region, not
//   the whole canvas.
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
      const h = 1;

      const areaSets = {
        FLIP_REG:  { reg: FLIP_REG,  keys: ["flip0","flip1","flip2","flip3"] },
        SPIN_REG:  { reg: SPIN_REG,  keys: ["spin0","spin1","spin2","spin3"] },
      };
      // idle/eat/move all share IDLE's own-aspect draw path and are meant to
      // read as the same size as one another, so they're audited as ONE set.
      const OWN_ASPECT_KEYS = ["cowIdle1","cowIdle2","eat0","eat1","eat2","eat3","mvL","mvR"];

      const out = {};
      for (const [name, { reg, keys }] of Object.entries(areaSets)){
        out[name] = keys.map((key, i) => {
          const img = IMG[key], R = reg[i];
          const k = (h / img.height) * R.s;
          const m = measure(img, 0, 0, img.width, img.height);
          return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                    k, apparentArea: k * k * m.opaquePx, s: R.s };
        });
      }
      // DUCK_REG, DIE_REG, and HURT_REG are tube-registered like the sets
      // above, but pinned to IDLE's OWN tube (cowabunga art) rather than
      // RIDER_TUBE_W (the old typhoon tube) -- see drawRider's
      // duckImg/dieImg/hurtImg branch in index.html. Kept out of tubeSets
      // above since they need this different reference width.
      // Unlike seasonPass (which SHOULD read as the same size across its own
      // frames -- a reaction, not a resize), duck0/1/2 are SUPPOSED to
      // shrink relative to one another as he tucks flatter (see DUCK_REG's
      // own comment) -- so an internal duck0-vs-duck1-vs-duck2 deviation
      // flag below is expected, not a bug. The number worth checking here is
      // duck0 (barely tucked) against OWN_ASPECT's cowIdle rows just below
      // -- those two SHOULD read as close to the same size. die0/1/2 and
      // hurt0/1/2, by contrast, SHOULD read flat across each set's own
      // frames -- hurt0/1/2 moved here 2026-09-14 after this exact audit,
      // run against the original own-aspect draw, flagged a ~20%
      // apparent-area spread between them (see HURT and DIE's own comment
      // in index.html).
      const idlePinnedSets = {
        DUCK_REG:  { reg: DUCK_REG,  keys: ["duck0","duck1","duck2"] },
        DIE_REG:   { reg: DIE_REG,   keys: ["die0","die1","die2"] },
        HURT_REG:  { reg: HURT_REG,  keys: ["hurt0","hurt1","hurt2"] },
      };
      for (const [name, { reg, keys }] of Object.entries(idlePinnedSets)){
        out[name] = keys.map((key, i) => {
          const img = IMG[key], R = reg[i];
          const imWIdle = h * (IMG.cowIdle2.width / IMG.cowIdle2.height);
          const dw = (imWIdle * IDLE_TUBE_W) / R.tw;
          const k = dw / img.width;
          const m = measure(img, 0, 0, img.width, img.height);
          return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                    k, apparentArea: k * k * m.opaquePx, tw: R.tw };
        });
      }
      // Cropped-own-aspect sets (see this file's header comment): each
      // frame's own real opaque bbox drawn at k = h / B.h, no shared
      // registration constant -- so, same as duck above, a real
      // frame-to-frame apparentArea spread here is EXPECTED (a splash/card
      // bloom growing the crop region, not the cow) and not itself a bug.
      // What matters is that this reads roughly flat against OWN_ASPECT's
      // cowIdle rows -- the character's own on-screen height, not the crop's.
      const croppedBboxSets = {
        SPEED_BBOX:      { bbox: SPEED_BBOX,      keys: ["speed0","speed1","speed2","speed3"] },
        SEASONPASS_BBOX: { bbox: SEASONPASS_BBOX, keys: ["sp0","sp1","sp2","sp3","sp4","sp5","sp6","sp7","sp8","sp9","sp10"] },
      };
      for (const [name, { bbox, keys }] of Object.entries(croppedBboxSets)){
        out[name] = keys.map((key, i) => {
          const img = IMG[key], B = bbox[i];
          const k = h / B.h;
          const m = measure(img, B.x, B.y, B.w, B.h);
          return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                    bboxW: B.w, bboxH: B.h,
                    k, apparentArea: k * k * m.opaquePx };
        });
      }
      out.OWN_ASPECT = OWN_ASPECT_KEYS.map((key) => {
        const img = IMG[key];
        const k = h / img.height;
        const m = measure(img, 0, 0, img.width, img.height);
        return { key, nativeW: img.width, nativeH: img.height, nativeOpaquePx: m.opaquePx,
                  bboxW: m.bboxW, bboxH: m.bboxH, cropTightness: m.bboxH / img.height,
                  k, apparentArea: k * k * m.opaquePx };
      });
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
        speedBoostPickup: { img: IMG.speedBoostPickup, H: SPEEDBOOST_PICKUP_H, glowR: SPEEDBOOST_PICKUP_GLOW_R, glowNote: "speedBoostPickupGlow halo, 0.92-1.08x pulse" },
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
      for (let i = 0; i < WORD.length; i++){
        const img = IMG["lt" + (i + 1)];
        const m = measure(img, WORD_SRC.x[i], WORD_SRC.y[i], WORD_SRC.w[i], WORD_SRC.h[i]);
        const k = LETTER_H / WORD_SRC.h[i];
        letterOut.push({
          key: "lt" + (i + 1), nativeCanvasW: img.width, nativeCanvasH: img.height,
          cropW: WORD_SRC.w[i], cropH: WORD_SRC.h[i], opaquePx: m.opaquePx,
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
  // shape's own linework" -- a letter with a thin rope-knot silhouette can
  // show a real opaquePx deviation among letters below despite each letter
  // being independently normalized to the same on-screen height via its own
  // WORD_SRC.h[i] (see this file's header comment) -- it just has less ink,
  // not a smaller bounding box. footprintArea has no such bias.
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
    // Some sprite sheets are large uncompressed exports pre-compress-assets.sh
    // (e.g. a freshly-split cowabunga-lean crop) -- poll IMG instead of a
    // fixed sleep so a slow local load doesn't race the measurement below.
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

    const riderFlagged = await auditRiderFrames(session);
    await auditIconsAndLetters(session);

    process.exitCode = riderFlagged ? 1 : 0; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
