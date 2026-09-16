#!/usr/bin/env node
// Measures FLIP_REG (s/cx/cy, rotation-invariant sqrt-area + centroid) for the
// new cowabunga-sprites/jump/cowabunga-jump_0N.png frames, off the real PNG
// alpha data via headless Chrome -- per AGENTS.md, "measure before coding,"
// not guessed. FLIP_REG's own comment (index.html, above the BACKFLIP block)
// defines the formula this reproduces:
//   s  = sqrt(area_restingSprite / area_frame) -- a shape's opaque area
//        doesn't change as it rotates, so this holds size steady where a
//        bounding-box fit would pump at 45 degrees.
//   cx/cy = the opaque centroid (the point the art turns about), as a
//        fraction of the frame's OWN canvas width/height.
// The resting sprite is still typhoon-rider.png (IMG.rider) -- drawRider()
// reads RIDER_CX/RIDER_CY and img.height off it regardless of which
// character art is animating, so it stays the denominator here too.
//
// node tools/jump-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SOURCES = [
  { key: "rider",  src: "assets/sprites/typhoon-sprites/typhoon-rider.png" },
  { key: "jump_01", src: "assets/sprites/cowabunga-sprites/jump/cowabunga-jump_01.png" },
  { key: "jump_02", src: "assets/sprites/cowabunga-sprites/jump/cowabunga-jump_02.png" },
  { key: "jump_03", src: "assets/sprites/cowabunga-sprites/jump/cowabunga-jump_03.png" },
  { key: "jump_04", src: "assets/sprites/cowabunga-sprites/jump/cowabunga-jump_04.png" },
];

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));

    const result = await evaluate(session, `
      (async () => {
        const sources = ${JSON.stringify(SOURCES)};
        const out = {};
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

          let area = 0, sumX = 0, sumY = 0;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const a = data[(y * img.width + x) * 4 + 3];
              if (a < 16) continue;
              area++; sumX += x; sumY += y;
            }
          }
          out[key] = {
            width: img.width, height: img.height, area,
            centroidX: sumX / area, centroidY: sumY / area,
            cx: (sumX / area) / img.width,
            cy: (sumY / area) / img.height,
          };
        }
        const riderArea = out.rider.area;
        const flip = ["jump_01", "jump_02", "jump_03", "jump_04"].map(k => ({
          key: k,
          s: Math.sqrt(riderArea / out[k].area),
          cx: Number(out[k].cx.toFixed(4)),
          cy: Number(out[k].cy.toFixed(4)),
        }));
        return { raw: out, FLIP_REG: flip };
      })()
    `, { awaitPromise: true });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
