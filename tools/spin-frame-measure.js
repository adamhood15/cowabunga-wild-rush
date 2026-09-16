#!/usr/bin/env node
// Measures rotation-invariant registration (s/cx/cy, same shape as FLIP_REG)
// for the cowabunga-sprites/spin/spin_0N.png whirlpool-spin frames, off the
// real PNG alpha data via headless Chrome -- per AGENTS.md, "measure before
// coding," not guessed.
//
// Why sqrt(area) + centroid rather than tube-width: the whole rider+tube
// assembly turns through a yaw here (front/quarter/back/quarter), so a
// profile frame's silhouette is genuinely narrower on screen (foreshortening,
// not cropping) -- a bounding-box or tube-width fit would incorrectly stretch
// it back out. Opaque AREA survives rotation, so sqrt(area) holds the rider's
// apparent size steady; the opaque centroid is the point he turns about. Same
// reasoning as FLIP_REG (see index.html's own comment above it).
//
// s resolves to sqrt(area_rider / area_frame), so it depends on the RESTING
// sprite's (typhoon-rider.png -- unmigrated, per AGENTS.md's power-up cap
// note this task didn't touch it) area as well as each frame's. Re-measure
// both this set's s values AND FLIP_REG/MOVE_REG's if typhoon-rider.png is
// ever re-exported.
//
// node tools/spin-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const RIDER_SRC = "assets/sprites/typhoon-sprites/typhoon-rider.png";
const FRAMES = [
  { key: "spin_01", src: "assets/sprites/cowabunga-sprites/spin/spin_01.png" },
  { key: "spin_02", src: "assets/sprites/cowabunga-sprites/spin/spin_02.png" },
  { key: "spin_03", src: "assets/sprites/cowabunga-sprites/spin/spin_03.png" },
  { key: "spin_04", src: "assets/sprites/cowabunga-sprites/spin/spin_04.png" },
];

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    await new Promise(r => setTimeout(r, 300));

    const result = await evaluate(session, `
      (async () => {
        const riderSrc = ${JSON.stringify(RIDER_SRC)};
        const frames = ${JSON.stringify(FRAMES)};

        const loadImg = (src) => new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = src;
        });

        const measure = (img) => {
          const cnv = document.createElement("canvas");
          cnv.width = img.width; cnv.height = img.height;
          const cx2d = cnv.getContext("2d");
          cx2d.drawImage(img, 0, 0);
          const data = cx2d.getImageData(0, 0, img.width, img.height).data;
          let area = 0, sumX = 0, sumY = 0;
          let minX = img.width, maxX = 0, minY = img.height, maxY = 0;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const a = data[(y * img.width + x) * 4 + 3];
              if (a < 16) continue;
              area++; sumX += x; sumY += y;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
          return {
            w: img.width, h: img.height, area,
            cx: (sumX / area) / img.width,
            cy: (sumY / area) / img.height,
            bbox: { minX, maxX, minY, maxY },
          };
        };

        const riderImg = await loadImg(riderSrc);
        const rider = measure(riderImg);

        const out = [];
        for (const { key, src } of frames) {
          const img = await loadImg(src);
          const m = measure(img);
          out.push({
            key, nativeW: m.w, nativeH: m.h, area: m.area,
            s: Math.sqrt(rider.area / m.area),
            cx: m.cx, cy: m.cy,
          });
        }
        return { rider: { area: rider.area, w: rider.w, h: rider.h }, frames: out };
      })()
    `, { awaitPromise: true });

    console.log(JSON.stringify(result, null, 2));
    console.log("\nconst SPIN_REG = [");
    for (const f of result.frames) {
      console.log(`  { s: ${f.s.toFixed(4)}, cx: ${f.cx.toFixed(4)}, cy: ${f.cy.toFixed(4)} },   // ${f.key}`);
    }
    console.log("];");

    const ss = result.frames.map(f => f.s);
    const spread = (Math.max(...ss) - Math.min(...ss)) / Math.min(...ss);
    console.log(`\ns values: ${ss.map(s => s.toFixed(4)).join(", ")} -- spread ${(spread * 100).toFixed(1)}%`);
    // FLIP_REG's own accepted frame-to-frame s spread is ~4.4% (2.2257-2.3229
    // before its own re-solve); allow some margin above that.
    process.exitCode = spread <= 0.15 ? 0 : 1;
    return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
