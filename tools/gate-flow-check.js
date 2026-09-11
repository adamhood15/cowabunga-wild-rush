#!/usr/bin/env node
// End-to-end check of the gate/landing page's Mailchimp signup wiring and
// its submit -> success -> redirectToGame() flow, on the REAL live page,
// without touching the real Mailchimp list: intercepts the JSONP request to
// list-manage.com (via CDP Fetch domain) and fulfills it locally with a fake
// {result:"success"} response, then drives a real form submit and watches
// where the page actually ends up. Also audits static wiring (duplicate
// form/field IDs, a stray official Mailchimp embed script alongside the
// hand-built one, an overlay covering the form) that a WP page-builder edit
// could silently break without touching this page's own script.
//
// Consolidated 2026-09-11 from gate-redirect-repro.js + gate-page-audit.js —
// both were written to investigate the same 2026-09-07 report (Adam, Chrome
// mobile, direct URL entry: success message showed but the redirect to
// /stampede-wild-rush/play/ never fired) and covered overlapping ground on
// the same page. gate-check.js stays separate: that one verifies the
// deployed route/gate plumbing, not this page's own form.
//
//   node tools/gate-flow-check.js [url] [viewport]

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const PAGE_URL = process.argv[2] || "https://typhoontexas.com/stampede-wild-rush/";
const viewportName = process.argv[3] || "phone412";
const viewport = VIEWPORTS[viewportName];
if (!viewport) throw new Error(`Unknown viewport "${viewportName}"`);

async function main() {
  const chrome = await launchChrome({});
  const results = { url: PAGE_URL, viewport: viewportName };
  try {
    const { session } = await openPage({ port: chrome.port, url: PAGE_URL, viewport });

    const consoleMessages = [];
    session.on("Runtime.consoleAPICalled", (params) => {
      consoleMessages.push({
        type: params.type,
        text: (params.args || []).map(a => a.value ?? a.description ?? "").join(" "),
      });
    });
    const exceptions = [];
    session.on("Runtime.exceptionThrown", (params) => {
      exceptions.push(params.exceptionDetails.exception?.description || JSON.stringify(params.exceptionDetails));
    });
    const navigations = [];
    session.on("Page.frameNavigated", (params) => {
      if (!params.frame.parentId) navigations.push({ url: params.frame.url, t: Date.now() });
    });
    const requests = [];
    session.on("Network.requestWillBeSent", (params) => requests.push(params.request.url));
    await session.send("Network.enable");

    const interceptedRequests = [];
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*list-manage.com*" }] });
    session.on("Fetch.requestPaused", async (params) => {
      const url = new URL(params.request.url);
      const callbackName = url.searchParams.get("c");
      const body = callbackName
        ? `${callbackName}({"result":"success","msg":"0 - test (intercepted, not a real Mailchimp submit)"});`
        : "";
      interceptedRequests.push({ url: params.request.url, callbackName, bodySent: body });
      await session.send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
        body: Buffer.from(body).toString("base64"),
      });
      // Diagnostic: did the script tag's callback actually get invoked?
      setTimeout(async () => {
        try {
          const stillExists = await evaluate(session, `typeof window[${JSON.stringify(callbackName)}]`);
          interceptedRequests[interceptedRequests.length - 1].callbackStillDefinedAfter300ms = stillExists;
        } catch (e) {
          interceptedRequests[interceptedRequests.length - 1].callbackCheckError = e.message;
        }
      }, 300);
    });

    // Reload so Fetch interception + the Network/Console listeners are
    // active from page load (gate-token fetch, WaterparkGate setup) onward.
    const reloaded = session.once("Page.loadEventFired");
    await session.send("Page.navigate", { url: PAGE_URL });
    await reloaded;
    await new Promise(r => setTimeout(r, 1500));   // let the async gate-token fetch land

    // --- static wiring audit (formerly gate-page-audit.js) ---
    results.duplicateIds = await evaluate(session, `
      (function () {
        var ids = ['mc-embedded-subscribe-form', 'mce-EMAIL', 'mce-SMSPHONE',
                    'mc-SMSPHONE-ack', 'mce-success-response', 'mce-error-response'];
        var out = {};
        ids.forEach(function (id) { out[id] = document.querySelectorAll('#' + id).length; });
        return out;
      })()
    `);
    results.hasOfficialMailchimpEmbed = await evaluate(session, `
      Array.prototype.some.call(document.querySelectorAll('script'), function (s) {
        return /mc-validate|list-manage\\.com\\/generate-js|chimpstatic/.test(s.src || '');
      })
    `);
    results.formCoveredByOverlay = await evaluate(session, `
      (function () {
        var form = document.getElementById('mc-embedded-subscribe-form');
        if (!form) return 'no form found';
        var r = form.getBoundingClientRect();
        var topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          topElement: topEl ? (topEl.tagName + (topEl.id ? '#' + topEl.id : '')) : null,
          isFormOrDescendant: !!(topEl && form.contains(topEl)),
        };
      })()
    `);
    results.waterparkGateBeforeSubmit = await evaluate(session, `({
      exists: typeof window.WaterparkGate !== 'undefined',
      redirectIsFunction: !!(window.WaterparkGate && typeof window.WaterparkGate.redirectToGame === 'function'),
    })`);
    results.gateTokenRequested = requests.some(u => u.includes("/gate-token"));

    // --- live submit -> redirect repro (formerly gate-redirect-repro.js) ---
    await evaluate(session, `
      (function () {
        document.getElementById('mce-FNAME').value = 'Test';
        document.getElementById('mce-LNAME').value = 'Rider';
        document.getElementById('mce-EMAIL').value = 'stampede-test@example.com';
        document.getElementById('mce-SMSPHONE').value = '(555) 555-0100';
        document.getElementById('mce-MMERGE130').checked = true; // Houston
        document.getElementById('mc-SMSPHONE-ack').checked = true;
      })()
    `);
    results.beforeUrl = await evaluate(session, "location.href");
    await evaluate(session, `
      document.getElementById('mc-embedded-subscribe-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    `);

    // Give the (now instant, intercepted) JSONP round trip and
    // redirectToGame() time to run, then watch location.href over a few
    // seconds to see if it changes once (redirect lands and stays) or
    // changes then bounces back (the originally reported "refreshed"
    // symptom -- game route rejects the token and 302s back to the gate).
    const urlSamples = [];
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 400));
      urlSamples.push(await evaluate(session, "location.href").catch(e => `(nav in progress: ${e.message})`));
    }

    results.urlSamplesAfterSubmit = urlSamples;
    results.consoleMessages = consoleMessages;
    results.exceptions = exceptions;
    results.interceptedRequests = interceptedRequests;
    results.navigations = navigations;

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
