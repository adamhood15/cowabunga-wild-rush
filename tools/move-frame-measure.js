#!/usr/bin/env node
// Measures tube registration (tw/cx/by, same shape as DUCK_REG/HURT_REG/
// DIE_REG) for cowabunga-move-left.png/cowabunga-move-right.png, off the
// real PNG alpha+color data via headless Chrome -- per AGENTS.md, "measure
// before coding," not guessed. Same teal ring detection as
// duck-frame-measure.js/hurt-frame-measure.js (this art's ring is the same
// teal COWABUNGA tube).
//
// Built 2026-09-17 after tools/rider-visual-size-check.js's baseline check
// (Adam: every cowabunga animation's tube should read as the same size as
// cowabunga-idle_01.png's) flagged MOVE's plain own-aspect draw rendering
// the tube +11.7%/+14.9% larger than the baseline -- own-aspect sizing only
// equalizes overall CHARACTER bbox height, not tube size specifically, the
// same gap that already forced DUCK/HURT/DIE off own-aspect and onto a
// tube-pinned fit. MOVE needs the same fix.
//
// node tools/move-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SOURCES = [
  { key: "idle_01",    src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_01.png" },
  { key: "idle_02",    src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_02.png" },
  { key: "move_left",  src: "assets/sprites/cowabunga-sprites/lean/cowabunga-move-left.png" },
  { key: "move_right", src: "assets/sprites/cowabunga-sprites/lean/cowabunga-move-right.png" },
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
          const w = img.width, h = img.height;
          const isTealAt = (x, y) => {
            const idx = (y * w + x) * 4;
            if (data[idx + 3] < 16) return false;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            return b > 110 && g > 70 && b >= g - 10 && r < 90 && (g - r) > 40;
          };
          const teal = new Uint8Array(w * h);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
              if (isTealAt(x, y)) teal[y * w + x] = 1;

          const labels = new Int32Array(w * h).fill(-1);
          const components = [];
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const p = y * w + x;
              if (labels[p] !== -1 || !teal[p]) continue;
              const stack = [p];
              labels[p] = components.length;
              let count = 0, cMinX = x, cMaxX = x, cMinY = y, cMaxY = y;
              while (stack.length) {
                const cur = stack.pop();
                count++;
                const cx = cur % w, cy = (cur / w) | 0;
                if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
                if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
                const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
                for (const [nx, ny] of neighbors) {
                  if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                  const np = ny * w + nx;
                  if (labels[np] !== -1 || !teal[np]) continue;
                  labels[np] = components.length;
                  stack.push(np);
                }
              }
              components.push({ count, cMinX, cMaxX, cMinY, cMaxY });
            }
          }
          const ringPieces = components.filter(c => (c.cMaxX - c.cMinX) > 0.35 * w);
          let tMinX = w, tMaxX = 0, tMinY = h, tMaxY = 0;
          for (const c of ringPieces) {
            if (c.cMinX < tMinX) tMinX = c.cMinX; if (c.cMaxX > tMaxX) tMaxX = c.cMaxX;
            if (c.cMinY < tMinY) tMinY = c.cMinY; if (c.cMaxY > tMaxY) tMaxY = c.cMaxY;
          }

          out.push({
            key, width: img.width, height: img.height,
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

main().catch(e => { console.error(e); process.exitCode = 1; });
