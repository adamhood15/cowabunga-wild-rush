#!/usr/bin/env node
// Measures tube registration (tw/cx/by, same shape as DUCK_REG/HURT_REG/EAT_REG)
// for the season-pass_0N.png rider-animation frames, off the real PNG
// alpha+color data via headless Chrome -- per AGENTS.md, "measure before
// coding," not guessed. Mirrors the tube-pinned frames already in index.html:
// the tube ring is the fixed feature across every frame, so its own
// width/centre/bottom-edge (as fractions of THAT frame's own image size) is
// what tw/cx/by describe.
//
// Adapted 2026-09-15 for the cowabunga-sprites re-export (11 frames, cow
// mascot holding a small rewards card): the tube ring is now BLUE, not the
// old typhoon rider's orange, so the color test changed to match. More
// importantly, several frames (01/03/04/05/09/10) hold the card up near the
// TOP of the frame, and its little "COWABUNGA CARD" logo is also blue --
// a naive global color bbox (the original approach, safe for the old art
// because nothing else in it was orange) would blow out to include that
// isolated logo patch and badly mis-measure cx/by. Flood-filling into
// connected components and keeping only the LARGEST one (the ring is
// thousands of contiguous pixels; the card logo is a few dozen, nowhere
// near it) fixes that. Re-run this (and re-derive the largest-component
// approach if a future re-export adds ANOTHER same-size blue prop near the
// ring) whenever this art is re-exported.
//
// node tools/season-pass-measure.js

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

          // Overall opaque bbox, for sanity/logging.
          let minX = W, maxX = 0, minY = H, maxY = 0;

          // Tube-ring mask: the ring's saturated cyan/blue -- low red, blue
          // meaningfully above both red and green. Tuned against an actual
          // pixel-frequency sample of season-pass_06.png (tools output, not
          // guessed), then checked it doesn't also catch the black outlines,
          // white highlights, red hibiscus/card-text, or tan/orange skin.
          const isTube = (r,g,b) => r < 80 && b > 150 && (b - r) > 90 && g > 80 && g < 220 && b >= g - 10;

          const mask = new Uint8Array(W * H);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const idx = (y * W + x) * 4;
              const a = data[idx + 3];
              if (a < 16) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (isTube(data[idx], data[idx+1], data[idx+2])) mask[y * W + x] = 1;
            }
          }

          // Flood-fill (4-connectivity, iterative stack) into components --
          // the ring is one large contiguous blob; the held card's logo, if
          // any blue pixels in it pass the mask, is a small isolated patch
          // nowhere near it. Keeping only the largest component discards
          // the latter automatically rather than needing to special-case
          // "ignore anything above such-and-such Y".
          const seen = new Uint8Array(W * H);
          let best = null;
          const stack = [];
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const start = y * W + x;
              if (!mask[start] || seen[start]) continue;
              let count = 0, cMinX = x, cMaxX = x, cMinY = y, cMaxY = y;
              stack.length = 0; stack.push(start); seen[start] = 1;
              while (stack.length) {
                const p = stack.pop();
                const py = (p / W) | 0, px = p - py * W;
                count++;
                if (px < cMinX) cMinX = px; if (px > cMaxX) cMaxX = px;
                if (py < cMinY) cMinY = py; if (py > cMaxY) cMaxY = py;
                const neighbors = [
                  py > 0 ? p - W : -1,
                  py < H - 1 ? p + W : -1,
                  px > 0 ? p - 1 : -1,
                  px < W - 1 ? p + 1 : -1,
                ];
                for (const n of neighbors) {
                  if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
                }
              }
              if (!best || count > best.count) {
                best = { count, minX: cMinX, maxX: cMaxX, minY: cMinY, maxY: cMaxY };
              }
            }
          }

          out.push({
            frame: f, width: W, height: H,
            opaque: { minX, maxX, minY, maxY },
            tubePixels: best ? best.count : 0,
            tube: best ? { minX: best.minX, maxX: best.maxX, minY: best.minY, maxY: best.maxY } : null,
            tw: best ? (best.maxX - best.minX) / W : null,
            cx: best ? ((best.minX + best.maxX) / 2) / W : null,
            by: best ? best.maxY / H : null,
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
