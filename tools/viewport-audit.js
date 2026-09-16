#!/usr/bin/env node
// Full viewport audit — walks every screen at every audit width with
// worst-case content and reports horizontal overflow, per TODOLIST.md
// "Verification sweeps needed". Rebuilt into tools/ per ARCHITECTURE.md
// (a general whole-flow walker and a viewport-overflow sweep have existed
// before and been lost to scratchpads twice already).
//
// For each (viewport, screen) pair: fresh navigate for isolation, force the
// screen from window globals with worst-case content (longest name pair,
// biggest score/coin/distance figures, all 8 letters lit), then scan the
// screen's own root element's subtree for:
//   - rect.right > document.documentElement.clientWidth  (pushed off the
//     right edge)
//   - rect.left < 0                                       (pushed off the
//     left edge)
//   - el.scrollWidth > el.clientWidth                      (content wider
//     than its own box), skipped for elements whose overflow-x is
//     hidden/clip — those clip+ellipsis on purpose (.reel__word, .lb-row__name,
//     .lb-row__score) and are not a bug by themselves.
//
// Deliberately does not touch the live leaderboard API: the leaderboard and
// name-claim screens are populated with synthetic worst-case rows/names
// directly, both so the sweep is deterministic and so it never adds more
// test rows to the Kinsta dev table (see TODOLIST.md).
//
// Usage:
//   node tools/viewport-audit.js                    # all screens, all widths
//   node tools/viewport-audit.js --shots             # screenshot every screen, not just failures
//   node tools/viewport-audit.js --viewports=w320,w768
//   node tools/viewport-audit.js --screens=hud,results-lose
//
// node tools/viewport-audit.js

const fs = require("node:fs");
const path = require("node:path");
const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const OUT_DIR = path.join(__dirname, "..", ".tmp-viewport-audit");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",") : null;
};

const SHOTS_ALL = flag("shots");
const VP_FILTER = opt("viewports");
const SCREEN_FILTER = opt("screens");

// Shared prelude, evaluated once per fresh navigation before any
// screen-specific setup: worst-case name (longest NAME_A + NAME_B pair, the
// same pool the reels actually draw from) and a stress figure big enough to
// exercise setFigure()'s shrink-to-fit (their own comment puts a skilled
// player's day-long score around 9 digits).
const PRELUDE = `
  window.__longestOf = (arr) => arr.reduce((a, b) => (b.length > a.length ? b : a));
  window.__worstName = __longestOf(NAME_A) + " " + __longestOf(NAME_B);
  window.__BIG = 123456789;
  true
`;

const SCREENS = [
  {
    name: "loading",
    root: "#load",
    setup: null, // scan before dismissLoader() ever runs
  },
  {
    name: "title",
    root: "#titlePanel",
    setup: `dismissLoader(); true`,
  },
  {
    name: "claim-name",
    root: "#namePanel",
    setup: `
      dismissLoader();
      byId("titlePanel").classList.remove("panel--on");
      byId("namePanel").classList.add("panel--on");
      reelA = __longestOf(NAME_A); reelB = __longestOf(NAME_B);
      paintReels();
      true
    `,
  },
  {
    name: "how-to-play",
    root: "#howPanel",
    setup: `dismissLoader(); openHow(); true`,
  },
  {
    name: "hud",
    root: "#hud",
    setup: `
      dismissLoader(); start();
      gotLetters = WORD.length; shownLetters = WORD.length;
      coins = __BIG; metres = __BIG;
      speed = CONFIG.maxSpeed * 1.4;   // past max: all horses lit + boosted
      paintLetters(); drawTubes(); syncHUD();
      true
    `,
  },
  {
    name: "paused",
    root: "#pausePanel",
    setup: `dismissLoader(); start(); pauseGame(); true`,
  },
  {
    name: "results-lose",
    root: "#overPanel",
    setup: `
      dismissLoader(); start();
      deathX = 40; deathY = 120; overTilt = 1;
      metres = __BIG; coins = __BIG;
      gotLetters = WORD.length - 1; shownLetters = WORD.length - 1;
      endRun();
      true
    `,
    // Injected after the panel is up rather than through Board/network: gives
    // fRankNote/fRank worst-case text without hitting the live dev API (see
    // TODOLIST.md on the Kinsta dev table's test data).
    // showOver() holds every child at opacity:0 until update() lifts it once
    // the (canvas-drawn) rider eases near its handoff slot — see the comment
    // on #overRider in index.html. deathX/deathY here are fixed stand-ins, not
    // a real crash position, so that ease can take up to OVER_HAND_MAX (5s).
    // The layout this audit cares about doesn't depend on that opacity at
    // all, but a useful screenshot does, so force the reveal classes directly
    // instead of waiting out the ease.
    postSetup: `
      byId("fRankNote").textContent = __worstName;
      byId("fRank").textContent = "#" + (999999).toLocaleString();
      overTextIn = true;
      byId("overPanel").classList.add("panel--text-in", "panel--rider-in");
      true
    `,
    postSettleMs: 900, // let the staggered .textIn overIn animation (up to ~0.46s + per-child delay) finish before the screenshot
  },
  {
    name: "results-win",
    root: "#overPanel",
    setup: `
      dismissLoader(); start();
      deathX = 40; deathY = 120; overTilt = 1;
      metres = __BIG; coins = __BIG;
      gotLetters = WORD.length; shownLetters = WORD.length;
      endRun();
      true
    `,
    postSetup: `
      byId("fRankNote").textContent = __worstName;
      byId("fRank").textContent = "#" + (999999).toLocaleString();
      overTextIn = true;
      byId("overPanel").classList.add("panel--text-in", "panel--rider-in");
      true
    `,
    postSettleMs: 900,
  },
  {
    name: "win-reveal",
    root: "#reveal",
    setup: `
      dismissLoader(); start();
      gotLetters = WORD.length; shownLetters = WORD.length;
      showReveal();
      true
    `,
  },
  {
    name: "leaderboard",
    root: "#lbPanel",
    setup: `
      dismissLoader();
      byId("titlePanel").classList.remove("panel--on");
      byId("lbPanel").classList.add("panel--on");
      const list = byId("lbList"); list.innerHTML = "";
      for (let i = 0; i < 50; i++){
        const d = document.createElement("div");
        d.className = "lb-row";
        d.innerHTML = '<span class="lb-row__pos"></span><span class="lb-row__name"></span><span class="lb-row__score"></span>';
        d.children[0].textContent = i + 1;
        d.children[1].textContent = __worstName;
        d.children[2].textContent = (999999999).toLocaleString();
        list.appendChild(d);
      }
      byId("lbEmpty").classList.remove("lb-empty--on");
      // The pinned "you" row below the top 50 (see renderBoard()).
      const you = byId("lbYou"); you.innerHTML = "";
      const d = document.createElement("div");
      d.className = "lb-row lb-row--me";
      d.innerHTML = '<span class="lb-row__pos"></span><span class="lb-row__name"></span><span class="lb-row__score"></span>';
      d.children[0].textContent = "3,412";
      d.children[1].textContent = __worstName;
      d.children[2].textContent = (999999999).toLocaleString();
      you.appendChild(d);
      true
    `,
  },
];

function scanExpr(rootSel) {
  return `
    (() => {
      const root = document.querySelector(${JSON.stringify(rootSel)});
      if (!root) return { error: "root not found: " + ${JSON.stringify(rootSel)} };
      const vw = document.documentElement.clientWidth;
      const nodes = [root, ...root.querySelectorAll("*")];
      const bad = [];
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const rightOver = rect.right - vw;
        const leftOver = -rect.left;
        const truncated = cs.overflowX === "hidden" || cs.overflowX === "clip";
        const scrollOver = truncated ? 0 : el.scrollWidth - el.clientWidth;
        const flags = [];
        if (rightOver > 0.5) flags.push("right");
        if (leftOver > 0.5) flags.push("left");
        // >4px, not >1px: flex rows with a gap legitimately round scrollWidth
        // vs. clientWidth by a few px with no visible effect (verified against
        // .ghost-row/.how-sec/#revealBtns, which flagged 1-6px at every width
        // including desktop, with no left/right edge crossing — that is
        // rounding noise, not overflow). A real burst runs to tens/hundreds
        // of px and typically comes with a right/left flag too.
        if (scrollOver > 4) flags.push("scrollWidth");
        if (flags.length) {
          bad.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: typeof el.className === "string" ? el.className.trim().slice(0, 60) : null,
            text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60),
            flags,
            vw,
            rectRight: Math.round(rect.right * 10) / 10,
            rectLeft: Math.round(rect.left * 10) / 10,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
        }
      }
      return { vw, count: bad.length, bad };
    })()
  `;
}

async function settle(ms) {
  await new Promise(r => setTimeout(r, ms));
}

async function gotoFresh(session, url) {
  const loaded = session.once("Page.loadEventFired");
  await session.send("Page.navigate", { url });
  await loaded;
}

async function main() {
  const viewportEntries = Object.entries(VIEWPORTS).filter(
    ([name]) => !VP_FILTER || VP_FILTER.includes(name)
  );
  const screens = SCREENS.filter(
    (s) => !SCREEN_FILTER || SCREEN_FILTER.includes(s.name)
  );

  if (!viewportEntries.length) throw new Error("No matching viewports for --viewports filter");
  if (!screens.length) throw new Error("No matching screens for --screens filter");

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = await launchChrome({});
  const report = [];
  const pageExceptions = [];
  try {
    for (const [vpName, viewport] of viewportEntries) {
      const { session } = await openPage({ port: chrome.port, url: SERVER, viewport });
      session.on("Runtime.exceptionThrown", (p) =>
        pageExceptions.push(`${vpName}: ` + JSON.stringify(p.exceptionDetails?.exception?.description || p.exceptionDetails))
      );

      for (const screen of screens) {
        await gotoFresh(session, SERVER);
        await settle(150);

        if (screen.setup !== null) {
          await evaluate(session, PRELUDE);
          await evaluate(session, screen.setup);
          await settle(350);
          if (screen.postSetup) {
            await evaluate(session, screen.postSetup);
            await settle(screen.postSettleMs || 100);
          }
        }

        const scan = await evaluate(session, scanExpr(screen.root));
        const entry = { viewport: vpName, width: viewport.width, screen: screen.name, ...scan };
        report.push(entry);

        const label = `${vpName.padEnd(9)} ${String(viewport.width).padStart(4)}px  ${screen.name.padEnd(14)}`;
        if (scan.error) {
          console.log(`${label}  ERROR: ${scan.error}`);
        } else if (scan.count > 0) {
          console.log(`${label}  FAIL (${scan.count} element${scan.count === 1 ? "" : "s"} overflow)`);
          for (const b of scan.bad) {
            console.log(`    <${b.tag}${b.id ? "#" + b.id : ""}> [${b.flags.join(",")}] "${b.text}"`);
          }
        } else {
          console.log(`${label}  ok`);
        }

        if (SHOTS_ALL || (scan.count > 0 && !scan.error)) {
          const shot = await session.send("Page.captureScreenshot", { format: "png" });
          const file = path.join(OUT_DIR, `${vpName}-${screen.name}.png`);
          fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        }
      }
    }

    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

    const failures = report.filter(r => r.error || r.count > 0);
    console.log("");
    console.log(`Checked ${report.length} screen/width pairs across ${viewportEntries.length} widths and ${screens.length} screens.`);
    console.log(`${failures.length} with overflow or errors.`);
    if (pageExceptions.length) {
      console.log(`${pageExceptions.length} uncaught page exception(s) during the sweep:`);
      pageExceptions.forEach(e => console.log("  " + e));
    }
    console.log(`Full report: ${path.join(OUT_DIR, "report.json")}`);
    if (fs.readdirSync(OUT_DIR).some(f => f.endsWith(".png"))) {
      console.log(`Screenshots: ${OUT_DIR}`);
    }

    process.exitCode = failures.length === 0 && pageExceptions.length === 0 ? 0 : 1; return;
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
