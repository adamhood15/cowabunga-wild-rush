#!/usr/bin/env node
// Verifies every power-up pickup adds POWERUP_SCORE_BONUS (150 points, via
// +15 coins -> runScore()'s coins*SC_COIN term) on top of whatever score
// effect it already had (Souvenir Bottle's own +100-coin burst included).
//
// node tools/powerup-score-bonus-check.js

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/index.html";
const SKIP_LOADER = `dismissLoader();`;
const SEED_RIDER = `localStorage.setItem("stampede.rider.v1", JSON.stringify({
  name: "Test Rider", token: "test-token", score: 0, at: Date.now()
}));`;

const TYPES = [
  { key: "BOOST", extra: 0 },
  { key: "SOUVENIR", extra: 100 }, // SOUVENIR_BONUS, stacked on top
  { key: "EXTRALIFE", extra: 0 },
  { key: "WHIRLPOOL", extra: 0 },
  { key: "SEASONPASS", extra: 0 },
];

async function main() {
  const chrome = await launchChrome({});
  const pageExceptions = [];
  let failed = false;
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport: VIEWPORTS.phone412 });
    session.on("Runtime.exceptionThrown", (p) => pageExceptions.push(p.exceptionDetails.text));
    await new Promise(r => setTimeout(r, 400));

    for (const { key, extra } of TYPES) {
      const result = await evaluate(session, `
        (() => {
          ${SEED_RIDER}
          ${SKIP_LOADER}
          start();
          lane = 0; laneA = 0;
          const before = { coins, score: runScore() };
          const e = add(T.${key}, travelled + 0.05, 0);
          update(0.016);
          return { before, after: { coins, score: runScore() }, dead: e.dead };
        })();
      `);
      const gained = result.after.coins - result.before.coins;
      const scoreGained = result.after.score - result.before.score;
      const expectedCoins = 15 + extra;
      const ok = result.dead && gained === expectedCoins && scoreGained === expectedCoins * 10;
      console.log(
        `${key}: dead=${result.dead} coins +${gained} (want ${expectedCoins}) ` +
        `score +${scoreGained} (want ${expectedCoins * 10}) -> ${ok ? "PASS" : "FAIL"}`
      );
      if (!ok) failed = true;
    }

    if (pageExceptions.length) {
      console.log("Page exceptions:", pageExceptions);
      failed = true;
    }
  } finally {
    await stopChrome(chrome);
  }
  process.exitCode = failed ? 1 : 0; return;
}

main().catch((e) => { console.error(e); process.exit(1); });
