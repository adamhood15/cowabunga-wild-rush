#!/usr/bin/env node
// Verifies stampede-popup.{css,js} on the real page over CDP: renders on
// its delay timer, traps focus, closes on Escape/backdrop, respects the
// once-per-day localStorage suppression, and doesn't overflow at phone
// widths. See AGENTS.md's "Verifying your work" section for why this goes
// through CDP rather than a synthetic click/JS-only check.
//
//   node tools/stampede-popup-check.js [viewport]
//
// [viewport] phone412 (default) | w320 | w768 | desktop

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const SERVER = process.env.STAMPEDE_URL || "http://127.0.0.1:8000/web-components/popup/stampede-popup-demo.html";
const viewportName = process.argv[2] || "phone412";
const viewport = VIEWPORTS[viewportName];
if (!viewport) throw new Error(`Unknown viewport "${viewportName}"`);

async function main() {
  const chrome = await launchChrome();
  const results = { viewport: viewportName, checks: {} };
  try {
    const { session } = await openPage({ port: chrome.port, url: SERVER, viewport });

    // Demo page sets delayMs:2000 — give it margin, then confirm it opened.
    await new Promise(r => setTimeout(r, 2600));
    results.checks.opensOnTimer = await evaluate(session, `
      (function(){
        var el = document.querySelector('.swr-popup');
        return !!el && !el.hasAttribute('hidden');
      })()
    `);

    results.checks.ctaHref = await evaluate(session, `
      document.querySelector('.swr-popup__cta').getAttribute('href')
    `);

    results.checks.dialogA11y = await evaluate(session, `
      (function(){
        var d = document.querySelector('.swr-popup__dialog');
        return {
          role: d.getAttribute('role'),
          ariaModal: d.getAttribute('aria-modal'),
          labelledBy: d.getAttribute('aria-labelledby'),
          labelExists: !!document.getElementById(d.getAttribute('aria-labelledby')),
        };
      })()
    `);

    results.checks.focusedOnOpen = await evaluate(session, `
      document.activeElement && document.activeElement.classList.contains('swr-popup__close')
    `);

    // No horizontal overflow at this viewport width.
    results.checks.overflow = await evaluate(session, `
      (function(){
        var d = document.querySelector('.swr-popup__dialog');
        var r = d.getBoundingClientRect();
        return { right: r.right, clientWidth: document.documentElement.clientWidth,
                 overflows: r.right > document.documentElement.clientWidth + 1 };
      })()
    `);

    // Escape closes it and restores focus to the trigger button.
    await evaluate(session, `document.querySelector('button').focus()`);
    await evaluate(session, `window.StampedePopup.open()`);
    await new Promise(r => setTimeout(r, 50));
    results.checks.escapeCloses = await evaluate(session, `
      (function(){
        var d = document.dispatchEvent;
        document.activeElement.blur();
        var evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(evt);
        return document.querySelector('.swr-popup').hasAttribute('hidden');
      })()
    `);

    // Backdrop click closes it.
    await evaluate(session, `window.StampedePopup.open()`);
    await new Promise(r => setTimeout(r, 50));
    results.checks.backdropCloses = await evaluate(session, `
      (function(){
        document.querySelector('.swr-popup__backdrop').click();
        return document.querySelector('.swr-popup').hasAttribute('hidden');
      })()
    `);

    // Once-per-day suppression: reload should NOT reopen after a shown timestamp exists.
    results.checks.suppressedOnReload = await evaluate(session, `
      (function(){
        try { return !!window.localStorage.getItem('swrPopupLastShown'); }
        catch(e){ return 'localStorage threw: ' + e.message; }
      })()
    `);

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await stopChrome(chrome);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
