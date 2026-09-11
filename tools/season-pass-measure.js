#!/usr/bin/env node
// Measures tube registration (tw/cx/by, same shape as DUCK_REG/HURT_REG/EAT_REG)
// for the nine season-pass_0N.png rider-animation frames, off the real PNG
// alpha+color data via headless Chrome -- per AGENTS.md, "measure before
// coding," not guessed. Mirrors the tube-pinned frames already in index.html:
// the orange inner-tube ring is the fixed feature across every frame, so its
// own width/centre/bottom-edge (as fractions of THAT frame's own image size)
// is what tw/cx/by describe.
//
// node tools/season-pass-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const FRAMES = Array.from({ length: 9 }, (_, i) => String(i + 1).padStart(2, "0"));

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
          const src = "assets/sprites/typhoon-sprites/season-pass/season-pass_" + f + ".png";
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

          // Overall opaque bbox, for sanity/logging.
          let minX = img.width, maxX = 0, minY = img.height, maxY = 0;
          // Orange-tube bbox: tuned to the tube's saturated orange (high R,
          // mid G, low-mid B, R meaningfully > G > B) -- distinguishes the
          // tube ring from the tan horse body, cream sunglasses/card, and
          // yellow mane/motion-lines.
          let tMinX = img.width, tMaxX = 0, tMinY = img.height, tMaxY = 0;
          let tubePixels = 0;

          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const idx = (y * img.width + x) * 4;
              const a = data[idx + 3];
              if (a < 16) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              const r = data[idx], g = data[idx + 1], b = data[idx + 2];
              const isOrange = r > 190 && r - g > 50 && g - b > 15 && g < 170;
              if (isOrange) {
                tubePixels++;
                if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x;
                if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y;
              }
            }
          }

          out.push({
            frame: f, width: img.width, height: img.height,
            opaque: { minX, maxX, minY, maxY },
            tubePixels,
            tube: { minX: tMinX, maxX: tMaxX, minY: tMinY, maxY: tMaxY },
            tw: (tMaxX - tMinX) / img.width,
            cx: ((tMinX + tMaxX) / 2) / img.width,
            by: tMaxY / img.height,
          });
        }
        return out;
      })()
    `, { awaitPromise: true });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
