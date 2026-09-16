#!/usr/bin/env node
// Measures a tube-width-style registration (tw/cx/by, same shape as
// DUCK_REG/HURT_REG) for the cowabunga-sprites/speed-boost/
// cowabunga-speed-boost_0N.png frames, off the real PNG alpha+color data via
// headless Chrome -- per AGENTS.md, "measure before coding," not guessed.
//
// History of getting this wrong THREE times (the first three attempts, and
// why the 4th's own predecessor was also wrong -- kept so nobody re-derives
// any of these dead ends from scratch):
// 1. sqrt(area) (rotation-invariant scheme, FLIP_REG/SPIN_REG's shape) --
//    held TOTAL footprint flat, so the splash bloom growing forced the cow
//    to shrink to compensate. Adam reported this 2026-09-11.
// 2. Height-pinned against each frame's own opaque bbox HEIGHT -- the bbox
//    bottom grows as splash reaches lower (582px -> 618px) even though the
//    bbox TOP (cow's head) never moves, so pinning against total bbox height
//    still shrank the cow ~8% to compensate. Adam reported the same
//    "shrinking" complaint again.
// 3. Own-aspect off native canvas height -- every canvas IS a constant 768px
//    tall, so this gave perfect frame-to-frame consistency, but rendered the
//    cow at roughly half the height it should be, since these canvases are
//    NOT tightly cropped to their opaque content (403-438px of content in a
//    768px-tall canvas).
// 4. A "waist" scan (narrowest opaque span at y=250-360) fed into the SAME
//    tube-width formula duck/hurt use -- this is the bug Adam reported
//    2026-09-14 ("speed-boost animation on the cow is so much larger than
//    the normal rider"). The waist is a real, stable feature (~182-186px
//    across all four frames), but it is NOT the tube ring -- it's the cow's
//    own crossed-arm pinch point, roughly 1/3 of the frame's width, while
//    the actual ring spans ~85-92% of it (same order as DUCK_REG's
//    0.83-0.89 and IDLE_TUBE_W's 0.894). The render formula
//    (`dw = imW * IDLE_TUBE_W / R.tw`) assumes R.tw IS the ring's own width
//    fraction -- feeding it a ~0.35 value in place of a ~0.85-0.92 one
//    inflated dw (and dh, which derives from dw) by roughly that same
//    2.4-2.6x ratio. The waist itself was never wrong; it was pinned against
//    the wrong reference.
// The bundled comment in that old attempt claimed the ring couldn't be
// isolated by color because the splash is "fused by color to the ring" --
// that claim was never actually verified against the art. It's false: this
// art's ring is the same teal COWABUNGA tube color duck/hurt/idle already
// isolate (duck-frame-measure.js's own mask), and per-row opaque-width vs
// teal-width comparisons in the ring's own y-band match almost exactly
// (splash pixels there are white/foam, which fails the teal test), so a
// plain color-masked bbox already recovers the ring cleanly -- no flood-fill
// component filtering needed (and duck's >35%-width component filter
// actively HURT this art: on some frames the ring's teal mask splits into
// arcs each under the 35% threshold, which silently dropped real ring pixels
// and undercounted tw).
//
// The one real contamination source: on the biggest-splash frames the spray
// itself picks up a teal tint high above the ring (observed up to y=251 on
// speed_04), which would blow tw back out if included. Restricting the scan
// to a y-band where the ring actually sits on every frame (0.45h-0.85h,
// clear of both the waist above and any airborne spray above that) avoids
// it -- confirmed by checking the restricted vs unrestricted bbox against
// each other, not assumed.
//
// Registered against IDLE_TUBE_W/CX/BY (index.html), same as DUCK_REG/
// HURT_REG -- this art's own resting tube, not the old typhoon-rider.png
// tube. Re-measure if this art is ever re-exported -- and if a future export
// moves the ring outside the 0.45h-0.85h band, re-verify the band itself
// rather than assuming it still applies.
//
// node tools/speed-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SOURCES = [
  { key: "speed_01", src: "assets/sprites/cowabunga-sprites/speed-boost/cowabunga-speed-boost_01.png" },
  { key: "speed_02", src: "assets/sprites/cowabunga-sprites/speed-boost/cowabunga-speed-boost_02.png" },
  { key: "speed_03", src: "assets/sprites/cowabunga-sprites/speed-boost/cowabunga-speed-boost_03.png" },
  { key: "speed_04", src: "assets/sprites/cowabunga-sprites/speed-boost/cowabunga-speed-boost_04.png" },
];
// Fraction-of-height band where the ring sits on every frame -- clear of the
// cow's own waist above it and any airborne spray-tint contamination higher
// still (see file header).
const RING_Y_BAND = [0.45, 0.85];

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));

    const result = await evaluate(session, `
      (async () => {
        const sources = ${JSON.stringify(SOURCES)};
        const [bandLo, bandHi] = ${JSON.stringify(RING_Y_BAND)};
        const out = [];
        for (const { key, src } of sources) {
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = src;
          });
          const cnv = document.createElement("canvas");
          cnv.width = img.width; cnv.height = img.height;
          const cx2d = cnv.getContext("2d");
          cx2d.drawImage(img, 0, 0);
          const data = cx2d.getImageData(0, 0, img.width, img.height).data;
          const w = img.width, h = img.height;
          // Same teal-tube mask as duck-frame-measure.js/hurt-frame-measure.js.
          const isTealAt = (x, y) => {
            const idx = (y * w + x) * 4;
            if (data[idx + 3] < 16) return false;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            return b > 110 && g > 70 && b >= g - 10 && r < 90 && (g - r) > 40;
          };
          const yLo = Math.floor(bandLo * h), yHi = Math.floor(bandHi * h);
          let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
          for (let y = yLo; y < yHi; y++) {
            for (let x = 0; x < w; x++) {
              if (!isTealAt(x, y)) continue;
              count++;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
          out.push({
            key, nativeW: w, nativeH: h, tealPixels: count,
            ring: { minX, maxX, minY, maxY },
            tw: (maxX - minX) / w,
            cx: ((minX + maxX) / 2) / w,
            by: maxY / h,
          });
        }
        return out;
      })()
    `, { awaitPromise: true });

    const tws = result.map(r => r.tw);
    const spread = (Math.max(...tws) - Math.min(...tws)) / Math.min(...tws);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\ntw values: ${tws.map(t => t.toFixed(4)).join(", ")} -- spread ${(spread * 100).toFixed(1)}%`);
    // DUCK_REG's own accepted frame-to-frame tw spread is ~7%; allow some
    // margin above that rather than pinning to its exact number.
    process.exitCode = spread <= 0.15 ? 0 : 1;
    return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
