#!/usr/bin/env node
// Measures tube registration (tw/cx/by, same shape as DUCK_REG/HURT_REG/EAT_REG)
// for the extra-life_0N.png eating-pose frames, off the real PNG alpha+color
// data via headless Chrome -- per AGENTS.md, "measure before coding," not
// guessed. Adapted from tools/season-pass-measure.js: same tw/cx/by shape
// (a fixed ring feature's own width/centre/bottom-edge, as fractions of
// THAT frame's own image size), but this art's ring is teal/cyan, not
// the rider set's orange, so the color test is swapped accordingly.
//
// node tools/eat-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const FRAMES = ["01", "02", "03", "04"];

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
          const src = "assets/sprites/typhoon-sprites/extra-life/extra-life_" + f + ".png";
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

          let minX = img.width, maxX = 0, minY = img.height, maxY = 0;
          // Teal-tube bbox: tuned to this art's ring (low R, mid-high G,
          // high B, B >= G > R) -- distinguishes the ring from the black
          // outlines, white highlights, tan/pink cow, and red swim trunks.
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
              const isTeal = b > 110 && g > 70 && b >= g - 10 && r < 90 && (g - r) > 40;
              if (isTeal) {
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
