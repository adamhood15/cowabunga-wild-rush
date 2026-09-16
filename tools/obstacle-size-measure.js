#!/usr/bin/env node
// Measures each obstacle sprite's own opaque-bbox height fraction
// (bboxH/canvasHeight) off the real PNG alpha data, alongside the same
// fraction for cowabunga-idle_02/03.png (the reference "full size" cow) --
// per AGENTS.md, "measure before coding."
//
// sprite() (index.html, drawEntInner's ENTITY_TYPE.COW/ENTITY_TYPE.YETI branch) draws an
// obstacle's WHOLE PNG at h = hUnits * s, so its apparent ON-SCREEN opaque
// height is h * (bboxH / img.height), not h itself -- a PNG with padding
// around its content reads smaller than one cropped tight, even at the same
// hUnits. Likewise drawRider's idleImg branch draws cowIdle's whole PNG at
// h_rider * sy (sy=1 at full/non-duck size), so cowIdle's own apparent
// opaque height is h_rider * (bboxH_idle / height_idle).
//
// To make an obstacle read as the SAME apparent height as cowIdle at full
// size, solve for the hUnits that equalizes the two apparent heights at the
// same projection scale (i.e. hUnits_obstacle * (bboxH_ob/H_ob) should equal
// 0.52 * (bboxH_idle/H_idle), the 0.52 being drawRider's own dominant hUnits
// coefficient, Math.max(0.52 * S, H * 0.12)'s first term).
//
// node tools/obstacle-size-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SOURCES = [
  { key: "cowIdle_02", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_02.png" },
  { key: "cowIdle_03", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_03.png" },
  { key: "cow",  src: "assets/sprites/obstacles/typhoon-waving_01.png" },
  { key: "cow2", src: "assets/sprites/obstacles/typhoon-waving_02.png" },
  { key: "yeti",  src: "assets/sprites/obstacles/yeti-tube.png" },
  { key: "yeti2", src: "assets/sprites/obstacles/daytona-snowman-2.png" },
  { key: "daytona-snowman-unused", src: "assets/sprites/obstacles/daytona-snowman.png" },
];

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));

    const result = await evaluate(session, `
      (async () => {
        const sources = ${JSON.stringify(SOURCES)};
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

          let minX = img.width, maxX = -1, minY = img.height, maxY = -1;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const a = data[(y * img.width + x) * 4 + 3];
              if (a < 16) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
          const bboxW = maxX >= minX ? (maxX - minX + 1) : 0;
          const bboxH = maxY >= minY ? (maxY - minY + 1) : 0;
          out.push({
            key, width: img.width, height: img.height,
            bboxW, bboxH,
            heightFrac: bboxH / img.height,
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

main().catch(e => { console.error(e); process.exitCode = 1; });
