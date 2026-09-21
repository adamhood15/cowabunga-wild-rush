#!/usr/bin/env node
// Measures each season-pass_0N.png rider-animation frame's own real opaque
// bounding box (native pixels, off the alpha channel) -- per AGENTS.md,
// "measure before coding," not guessed.
//
// SEASONPASS_REG (index.html) pinned every frame's tube-ring width/centre/
// base to RIDER_TUBE_W, the old typhoon-rider.png tube -- normalizing the
// RING to a fixed size across frames. Adam reported the cow visibly
// shrinking and growing through the animation (2026-09-21): the ring stayed
// pinned, but the surrounding art (card, sparkle burst, motion lines) isn't
// uniformly padded frame to frame, so pinning the ring left the CHARACTER
// itself scaling to compensate -- same failure shape SPEED_BBOX (see its own
// comment in index.html) was built to fix for speed-boost, and Adam's call
// there ("pull the frames in at their extracted sizes and not standardize
// the sizes at all") applies the same way here: stop normalizing against any
// single measured feature (ring, bbox, area) and just draw each frame's own
// opaque content at whatever size it natively implies, cropped tight to real
// content first (these canvases carry transparent padding, so a plain
// own-aspect draw off the whole canvas would undersize every frame, same as
// it would have for speed-boost -- see SPEED_BBOX's own comment).
//
// Plain alpha-channel bbox, no color masking needed -- unlike
// season-pass-measure.js's tube-ring isolation (which has to dodge the held
// card's blue logo), this just wants the frame's total opaque footprint,
// the same MEASURE_HELPER.measure() shape tools/sprite-size-audit.js already
// uses to report bboxW/bboxH.
//
// node tools/season-pass-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const FRAMES = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(2, "0"));

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));

    const result = await evaluate(session, `
      (async () => {
        const frames = ${JSON.stringify(FRAMES)};
        const out = [];
        for (const f of frames) {
          const src = "assets/sprites/cowabunga-sprites/season-pass/season-pass_" + f + ".png";
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
          const W = img.width, H = img.height;

          let minX = W, maxX = -1, minY = H, maxY = -1;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const a = data[(y * W + x) * 4 + 3];
              if (a < 16) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
          // bbox is inclusive of the last opaque pixel -> +1 for a true span
          out.push({
            frame: f, nativeW: W, nativeH: H,
            x: minX, y: minY,
            w: maxX >= minX ? (maxX - minX + 1) : 0,
            h: maxY >= minY ? (maxY - minY + 1) : 0,
          });
        }
        return out;
      })()
    `, { awaitPromise: true });

    console.log(JSON.stringify(result, null, 2));
    console.log("\nconst SEASONPASS_BBOX = [");
    for (const r of result) {
      console.log(`  { x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h} },   // season-pass_${r.frame}`);
    }
    console.log("];");

    process.exitCode = 0; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
