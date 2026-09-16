#!/usr/bin/env node
// Measures tube registration (tw/cx/by, same shape as DUCK_REG/DIE_REG) for
// the cowabunga-sprites/hurt/hurt_0N.png frames, off the real PNG
// alpha+color data via headless Chrome -- per AGENTS.md, "measure before
// coding," not guessed. Adapted from tools/duck-frame-measure.js: same teal
// ring detection (this art's ring is the same teal COWABUNGA tube used by
// the idle/eat/move/duck sets, not the old typhoon rider's orange tube).
//
// Built 2026-09-14 after the plain own-aspect draw (h/img.height, same as
// idle/eat/move) was shown to make the hurt cow visibly change size frame to
// frame: sprite-size-audit.js's OWN_ASPECT set put hurt0/hurt1/hurt2 at
// apparent areas of ~0.60/0.66/0.72 (hurt2 ~20% bigger than hurt0), because
// hurt_01's tall spark/lightning burst and hurt_03's puff decoration eat
// into each frame's own opaque bbox height by a different amount -- own-
// aspect sizing (which scales the WHOLE bbox including those decorations to
// a fixed h) shrinks the cow himself whenever the decoration reaches
// higher. The tube ring itself doesn't move between frames (same reaction-
// in-place pose as duck), so it's the stable feature to pin against, the
// same fix DUCK_REG already applies for its own art.
//
// Also measures the reference idle frame (cowabunga-idle_02.png) with the
// same probe, so index.html can pin the hurt frames' tube width to IDLE's
// own on-screen tube size instead of the old RIDER_TUBE_W (which belongs to
// a differently-proportioned, now-unused typhoon tube) -- see the "own
// aspect ratio" comments already in index.html for idle/eat/move for why
// that mismatch shrank/grew replacement art relative to idle before.
//
// node tools/hurt-frame-measure.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SOURCES = [
  { key: "idle_02", src: "assets/sprites/cowabunga-sprites/idle/cowabunga-idle_02.png" },
  { key: "hurt_01", src: "assets/sprites/cowabunga-sprites/hurt/hurt_01.png" },
  { key: "hurt_02", src: "assets/sprites/cowabunga-sprites/hurt/hurt_02.png" },
  { key: "hurt_03", src: "assets/sprites/cowabunga-sprites/hurt/hurt_03.png" },
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

          let minX = img.width, maxX = 0, minY = img.height, maxY = 0;
          // Teal-tube mask: same color test as eat-frame-measure.js (low R,
          // mid-high G, high B, B >= G > R) -- distinguishes the ring from
          // black outlines, white highlights, the tan/cow-print body, red
          // trunks. The duck art also has a thin blue accent swoosh (near the
          // horns in duck_02) that passes this same color test but is a tiny,
          // disconnected blob -- so unlike eat-frame-measure.js, take the
          // LARGEST connected teal component (flood fill) rather than the
          // naive bbox of every teal pixel, or that swoosh corrupts by/tw.
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

          // The ring is one torus, but the cow's crossed arms/hooves rest ON
          // TOP of it in every duck pose, cutting the connected teal band into
          // a few big arcs (black outline pixels break connectivity there),
          // while the water splash droplets scattered around the badge are
          // ALSO teal but are many small, narrow, disconnected blobs. Picking
          // "the single largest component" (plain, or after a dilation radius
          // large enough to rejoin the ring) is fragile either way -- too
          // small a radius keeps the ring split into competing fragments, too
          // large starts also fusing in the nearby splashes, and the radius
          // that works differs between idle (splashes sit close to the ring)
          // and duck (they don't). Instead: label with NO dilation, then take
          // the UNION of every component wide enough to plausibly be a piece
          // of the ring itself (> 35% of the frame's own width) -- no lone
          // splash droplet is that wide, but every ring arc split off by an
          // occluding arm still is, so this reassembles the true ring bbox
          // from its pieces without ever touching a splash component.
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
                const neighbors = [
                  [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
                ];
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
          let tMinX = w, tMaxX = 0, tMinY = h, tMaxY = 0, tCount = 0;
          for (const c of ringPieces) {
            if (c.cMinX < tMinX) tMinX = c.cMinX; if (c.cMaxX > tMaxX) tMaxX = c.cMaxX;
            if (c.cMinY < tMinY) tMinY = c.cMinY; if (c.cMaxY > tMaxY) tMaxY = c.cMaxY;
            tCount += c.count;
          }
          const tube = { tMinX, tMaxX, tMinY, tMaxY, count: tCount, pieces: ringPieces.length };

          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = (y * w + x) * 4;
              if (data[idx + 3] < 16) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }

          out.push({
            key, width: img.width, height: img.height,
            opaque: { minX, maxX, minY, maxY },
            tubePixels: tube.count,
            componentCount: components.length,
            ringPieces: tube.pieces,
            tube: { minX: tube.tMinX, maxX: tube.tMaxX, minY: tube.tMinY, maxY: tube.tMaxY },
            tw: (tube.tMaxX - tube.tMinX) / img.width,
            cx: ((tube.tMinX + tube.tMaxX) / 2) / img.width,
            by: tube.tMaxY / img.height,
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
