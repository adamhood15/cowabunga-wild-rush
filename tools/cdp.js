// Minimal Chrome DevTools Protocol client for headless verification.
//
// Why hand-rolled: no npm dependency, no build step, matches the rest of the
// project. Uses Node's built-in `WebSocket` (Node >=22) — no `ws` package.
//
// Usage: see tools/README.md and tools/screenshot.js for a worked example.
//
// AGENTS.md / HANDOFF.md traps this file exists to avoid re-learning:
//   - Never launch with --window-size. Headless Chrome clamps it to a 500px
//     minimum, so a "412px" screenshot is actually rendered at 500px and
//     scaled down — it reads ~25% too large and invents overflow that is not
//     real. Use Emulation.setDeviceMetricsOverride instead.
//   - Force screens from window globals (state, start(), reset(), gameOver(),
//     showOver(), showReveal(), openBoard()) rather than synthesising clicks.
//     A JS-dispatched PointerEvent does not carry the user-activation bit and
//     cannot reproduce audio-unlock bugs; Input.dispatchTouchEvent does.
//   - Always clean up with `await stopChrome(chrome)` in a finally block —
//     never chrome.child.kill() by itself. See stopChrome's own comment.

const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  process.env.CHROME_PATH,
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("No Chrome/Chromium binary found. Set CHROME_PATH.");
}

// Known-good phone viewports for this page (AGENTS.md), plus the audit widths
// from HANDOFF item 7. Callers can also pass an arbitrary {width,height,dsf}.
const VIEWPORTS = {
  phone412: { width: 412, height: 915, dsf: 2, mobile: true },   // the user's phone class
  w320:     { width: 320, height: 800, dsf: 2, mobile: true },   // small Android / SE
  w360:     { width: 360, height: 800, dsf: 2, mobile: true },   // most common Android
  w390:     { width: 390, height: 844, dsf: 2, mobile: true },
  w768:     { width: 768, height: 1024, dsf: 2, mobile: false }, // tablet
  desktop:  { width: 1280, height: 800, dsf: 1, mobile: false },
};

// A fixed default port meant two concurrent tool runs (two sessions, or two
// tools in the same session) could both bind 9333 -- the second Chrome fails
// to claim the port but still starts, and waitForDevtools() below then finds
// the FIRST one's devtools endpoint still answering and happily attaches to
// that stale, unrelated browser instead. Symptom is a test that hangs for
// real (a `while` loop against page state that will never arrive) rather
// than a clean connection failure, which is what actually happened running
// two sessions' tools side by side (2026-08-27). Randomizing the default
// per-process makes a collision unlikely without requiring every caller to
// coordinate a port; pass an explicit port to pin one on purpose.
function defaultPort() { return 9200 + Math.floor(Math.random() * 800); }

async function launchChrome({ port = defaultPort() } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stampede-cdp-"));
  const bin = findChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // Lets tests reproduce the real autoplay policy rather than the lenient
    // default headless sometimes applies — see AGENTS.md audio section.
    "--autoplay-policy=document-user-activation-required",
  ];
  const child = spawn(bin, args, { stdio: "ignore" });
  const target = await waitForDevtools(port);
  return { child, port, userDataDir, ...target };
}

// Every tool's finally block MUST call this — never chrome.child.kill() plus
// a manual rmSync, and never a bare `try { chrome.child.kill() } catch {}`
// with no cleanup at all. Both of those leave orphans: SIGTERM to just the
// launcher PID does not reliably take its GPU/renderer helper processes with
// it (they're macOS-sandboxed children — --seatbelt-client on their command
// line — and don't share the launcher's process group), so `child.kill()`
// alone can exit the launcher while its helpers keep running and pegging
// CPU. Piled-up `stampede-cdp-*` Chrome Helper processes have hit the user's
// machine this way before (2026-09-11) — see AGENTS.md's kill-by-port-or-
// user-data-dir warning, which this function exists to make automatic.
// Matching every process whose command line references this run's own
// --user-data-dir is what actually reaches every helper: userDataDir came
// from mkdtemp, so the match can't collide with another concurrent run's.
async function stopChrome(chrome) {
  // A single pkill pass can race a helper that's still mid-fork the instant
  // it runs -- extension/audio/utility/GPU processes spawn lazily off page
  // activity, and every page under test here keeps requestAnimationFrame
  // ticking right up to the moment Chrome dies, so a straggler can be born
  // after the first sweep has already run. Repeat until a pass finds nothing
  // left, capped so a truly stuck process can't hang the tool.
  for (let i = 0; i < 8; i++) {
    let matched = true;
    try {
      execSync(`pkill -9 -f ${JSON.stringify(chrome.userDataDir)}`, { stdio: "ignore" });
    } catch (e) { matched = false; }   // pkill exits 1 when nothing matched
    if (!matched) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise((resolve) => {
    if (chrome.child.exitCode !== null || chrome.child.signalCode !== null) { resolve(); return; }
    chrome.child.once("exit", resolve);
    setTimeout(resolve, 1500);   // don't hang the tool if the exit event never lands
  });
  fs.rmSync(chrome.userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

async function waitForDevtools(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Chrome DevTools endpoint never came up: " + lastErr);
}

class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // event name -> Set<fn>
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) for (const fn of set) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  once(method) {
    return new Promise((resolve) => {
      const off = this.on(method, (params) => { off(); resolve(params); });
    });
  }
}

// index.html's Board talks to a live Kinsta DEV backend (DATABASE.md — the
// API constant is a temporary absolute URL, not same-origin), not a sandbox.
// Every tool here goes through openPage(), so this guard runs by default:
// installed via Page.addScriptToEvaluateOnNewDocument, it patches
// window.fetch BEFORE the page's own <script> ever executes, so it catches
// even a request fired at page-load time (e.g. the naming screen's
// namesPromise). It only blocks WRITES — POST /claim and POST /submit, the
// two routes that create or change a row — leaving GET /leaderboard, /rank,
// and /names to hit the real dev API, since a blocked read would change what
// these tools can verify for no write-safety benefit.
// A blocked call rejects the same way a real dropped connection would
// (fetch() throwing a TypeError), which is exactly the failure mode
// Board.claim()/Board.submit() already handle — see DATABASE.md's own
// "fails open" design — so this changes WHY a call fails in a tool that
// never depended on it succeeding, never WHETHER it fails.
// Pass allowBoardWrites: true only for a test that genuinely needs the real
// backend; per Adam's request (2026-08-27), such a test should claim under
// an identifiable test name/token (e.g. a fixed adjective/noun pair reserved
// for testing) so any row it creates is obviously not a real player's.
const BOARD_WRITE_GUARD = `(() => {
  const BLOCKED = [/\\/claim(?:$|\\?)/, /\\/submit(?:$|\\?)/];
  const realFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (BLOCKED.some(re => re.test(url))) {
      return Promise.reject(new TypeError(
        "stampede test tooling: blocked a real /claim or /submit request to " + url
      ));
    }
    return realFetch(input, init);
  };
})();`;

async function openPage({ port, url, viewport = VIEWPORTS.phone412, allowBoardWrites = false }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const session = new CDPSession(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  if (!allowBoardWrites) {
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: BOARD_WRITE_GUARD });
  }
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.dsf,
    mobile: !!viewport.mobile,
  });
  if (viewport.mobile) {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  const loaded = session.once("Page.loadEventFired");
  await session.send("Page.navigate", { url });
  await loaded;
  return { session, targetId: target.id, ws };
}

// Runtime.evaluate wrapper that throws JS-side exceptions as real errors
// instead of silently returning `undefined`.
async function evaluate(session, expression, { awaitPromise = false } = {}) {
  const result = await session.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error("Page threw: " + JSON.stringify(result.exceptionDetails.exception));
  }
  return result.result.value;
}

module.exports = { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS, CDPSession };
