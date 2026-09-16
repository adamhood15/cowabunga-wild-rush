#!/usr/bin/env node
// Measures WORD_SRC (x/w/cw per letter, shared y, per-letter h) for the
// letter_0N.png files off their real PNG alpha data via headless Chrome --
// per AGENTS.md, "measure before coding," not guessed. Mirrors
// season-pass-measure.js's approach for a different sprite set.
//
// Unlike the old letters_0N.png set, these files are NOT exported onto one
// shared padded canvas -- each is cropped tight to its own ink, and canvas
// HEIGHT varies letter to letter (e.g. a rope knot riding higher on one
// glyph). So WORD_SRC.h must become a per-letter array here rather than the
// old single scalar, and WORD_SRC.y stays a single 0 only because every
// file's ink independently starts flush at its own canvas top -- verified
// below, not assumed.
//
// node tools/letter-word-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const COUNT = 9;
const FRAMES = Array.from({ length: COUNT }, (_, i) => String(i + 1).padStart(2, "0"));

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
          const src = "assets/sprites/letters/letter_" + f + ".png";
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

          out.push({
            file: f, cw: img.width, canvasH: img.height,
            x: minX, xMax: maxX, w: maxX - minX + 1,
            yMin: minY, yMax: maxY, h: maxY - minY + 1,
          });
        }
        return out;
      })()
    `, { awaitPromise: true });

    console.log(JSON.stringify(result, null, 2));

    const allTopFlush = result.every(r => r.yMin === 0);
    console.log("\\nAll letters ink-flush at canvas top (y=0):", allTopFlush);
    console.log("\\nWORD_SRC (paste into index.html):");
    console.log("const WORD_SRC = {");
    console.log("  y: 0,");
    console.log("  h:  [" + result.map(r => r.canvasH).join(", ") + "],");
    console.log("  x:  [" + result.map(r => r.x).join(", ") + "],");
    console.log("  w:  [" + result.map(r => r.w).join(", ") + "],");
    console.log("  cw: [" + result.map(r => r.cw).join(", ") + "],");
    console.log("};");
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
