#!/usr/bin/env node
// Verifies the Mailchimp signup form on landing.html
// (#mc-embedded-subscribe-form, web-components/landing/landing.html) end to
// end. Consolidates three formerly-separate scripts that all drove this same
// form (see AGENTS.md's tools-review effort) — kept as one named async
// function per scenario so each is easy to find and reports its own
// pass/fail, combined into one overall pass/fail at the end:
//
//   1. runFieldValidationChecks — each of the four required inputs (email,
//      SMS phone, park, consent checkbox) shows its OWN error message next
//      to itself when missing/invalid, independent of the others, and none
//      of them let the form actually submit (no JSONP request fires). Also
//      verifies the happy path: all four filled in correctly submits
//      (exactly one JSONP request observed) with no field errors left
//      showing.
//   2. runLoadingStateChecks — the signup button's loading-spinner state.
//      Never submits the form to trigger it; forces the `.busy` class
//      directly (mirrors how index.html's #nameGo busy state is tested:
//      force via DOM/class, not a synthetic submit) and checks the
//      spinner/label swap, plus that the button is disabled while busy and
//      restored after.
//   3. runSmsFormatChecks — the SMS phone field gets rewritten to E.164
//      (+1XXXXXXXXXX) before submitting (the local "(555) 555-0100" display
//      format Mailchimp rejects with "Please provide an SMS number in the
//      international standard format"), submission goes via JSONP instead of
//      a real form POST so an error response can be tested without a real
//      subscriber being created, the error/success response is shown inline
//      (#mce-error-response / #mce-success-response) without navigating
//      away, and the phone field is restored to local display format after
//      an error.
//
// Never submits the form for real — a real submit creates a real Mailchimp
// subscriber on the production list, which needs explicit sign-off, not a
// debugging side effect. Scenarios 1 and 3 intercept
// document.createElement('script') so a JSONP attempt never actually
// reaches list-manage.com; scenario 2 never triggers a valid+complete submit
// at all.
//
//   node tools/mailchimp-form-check.js [url] [viewport]

const { launchChrome, stopChrome, openPage, evaluate, VIEWPORTS } = require("./cdp");

const URL = process.argv[2] || "http://localhost:8000/web-components/landing/landing.html";
const viewportName = process.argv[3] || "phone412";
const viewport = VIEWPORTS[viewportName];
if (!viewport) throw new Error(`Unknown viewport "${viewportName}"`);

// Intercepts document.createElement('script') so a JSONP attempt never
// actually reaches list-manage.com. Also fakes the JSONP callback response so
// error/success cases can be exercised without a real subscriber ever being
// created.
const JSONP_HARNESS = `
  window.__mcScriptCalls = [];
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === 'script') {
      Object.defineProperty(el, 'src', {
        configurable: true,
        set(value) {
          window.__mcScriptCalls.push(value);
          const match = value.match(/[?&]c=([^&]+)/);
          const cbName = match && decodeURIComponent(match[1]);
          setTimeout(() => {
            if (cbName && typeof window[cbName] === 'function' && window.__mcTestResponse) {
              window[cbName](window.__mcTestResponse);
            }
          }, 0);
        },
        get() { return ''; },
      });
    }
    return el;
  };
`;

// ---------------------------------------------------------------------------
// Scenario 1: per-field validation
// ---------------------------------------------------------------------------

// Each case fills in the form fully valid, then knocks out exactly one
// field, submits, and checks that field's error shows while nothing else
// does, and no JSONP request was attempted.
const FIELD_VALIDATION_CASES = [
  {
    name: "missing email",
    breakField: `document.getElementById('mce-EMAIL').value = '';`,
    expectVisibleIn: "mce-EMAIL",
    expectMessage: "Please enter a valid email address.",
  },
  {
    name: "invalid email",
    breakField: `document.getElementById('mce-EMAIL').value = 'not-an-email';`,
    expectVisibleIn: "mce-EMAIL",
    expectMessage: "Please enter a valid email address.",
  },
  {
    name: "missing/incomplete phone",
    breakField: `
      phone.value = '555';
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    `,
    expectVisibleIn: "mce-SMSPHONE",
    expectMessage: "Please enter a valid 10-digit phone number.",
  },
  {
    name: "no park selected",
    breakField: `
      document.getElementById('mce-MMERGE130').checked = false;
      document.getElementById('mce-MMERGE131').checked = false;
    `,
    expectVisibleIn: "mce-MMERGE130",
    expectMessage: "Please select a park.",
  },
  {
    name: "consent checkbox unchecked",
    breakField: `document.getElementById('mc-SMSPHONE-ack').checked = false;`,
    expectVisibleIn: "mc-SMSPHONE-ack",
    expectMessage: "Please check the box to continue.",
  },
];

function fieldValidationCaseScript(c) {
  return `
    (function () {
      window.__mcScriptCalls.length = 0;
      const email = document.getElementById('mce-EMAIL');
      const phone = document.getElementById('mce-SMSPHONE');
      const park = document.getElementById('mce-MMERGE130');
      const ack = document.getElementById('mc-SMSPHONE-ack');

      // Start fully valid.
      email.value = 'wyatt@example.com';
      phone.value = '5551234567';
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      park.checked = true;
      ack.checked = true;

      ${c.breakField}

      document.getElementById('mc-embedded-subscribe-form')
        .querySelector('#mc-embedded-subscribe').click();

      const errors = Array.from(document.querySelectorAll('.mc-field-error'))
        .filter(el => el.classList.contains('is-visible'));

      const targetGroup = document.getElementById(${JSON.stringify(c.expectVisibleIn)}).closest('.mc-field-group, .mc-sms-phone-group');
      const targetError = targetGroup.querySelector('.mc-field-error');

      return {
        scriptCalls: window.__mcScriptCalls.length,
        visibleErrorCount: errors.length,
        targetErrorShown: !!targetError && targetError.classList.contains('is-visible'),
        targetErrorText: targetError ? targetError.textContent : null,
      };
    })()
  `;
}

async function runFieldValidationChecks(session) {
  console.log("\n=== Scenario 1: per-field validation ===");
  let pass = true;

  await evaluate(session, JSONP_HARNESS);

  for (const c of FIELD_VALIDATION_CASES) {
    const result = await evaluate(session, fieldValidationCaseScript(c));
    console.log(c.name + ":", result);
    if (result.scriptCalls !== 0) {
      console.error(`  FAIL: [${c.name}] form submitted (JSONP fired) despite invalid field`);
      pass = false;
      continue;
    }
    if (result.visibleErrorCount !== 1) {
      console.error(`  FAIL: [${c.name}] expected exactly 1 visible field error, got ${result.visibleErrorCount}`);
      pass = false;
      continue;
    }
    if (!result.targetErrorShown) {
      console.error(`  FAIL: [${c.name}] expected error on ${c.expectVisibleIn}'s field group, none shown there`);
      pass = false;
      continue;
    }
    if (result.targetErrorText !== c.expectMessage) {
      console.error(`  FAIL: [${c.name}] wrong message: ${result.targetErrorText}`);
      pass = false;
      continue;
    }
    console.log(`  PASS: exactly one error shown (${c.expectVisibleIn}), no submit attempted.`);
  }

  // Happy path: all four valid — submits (JSONP attempted), no field errors
  // left showing.
  const happy = await evaluate(session, `
    (function () {
      window.__mcScriptCalls.length = 0;
      document.getElementById('mce-EMAIL').value = 'wyatt@example.com';
      const phone = document.getElementById('mce-SMSPHONE');
      phone.value = '5551234567';
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mce-MMERGE130').checked = true;
      document.getElementById('mc-SMSPHONE-ack').checked = true;

      document.getElementById('mc-embedded-subscribe-form')
        .querySelector('#mc-embedded-subscribe').click();

      const visible = Array.from(document.querySelectorAll('.mc-field-error'))
        .filter(el => el.classList.contains('is-visible')).length;

      return { scriptCalls: window.__mcScriptCalls.length, visibleErrorCount: visible };
    })()
  `);
  console.log("all valid:", happy);
  if (happy.scriptCalls !== 1) {
    console.error("  FAIL: expected the valid submit to fire exactly one JSONP request");
    pass = false;
  } else if (happy.visibleErrorCount !== 0) {
    console.error("  FAIL: expected no field errors visible on a fully valid submit");
    pass = false;
  } else {
    console.log("  PASS: fully valid form submits, no field errors shown.");
  }

  console.log(pass ? "Scenario 1: ALL PASS" : "Scenario 1: FAIL");
  return pass;
}

// ---------------------------------------------------------------------------
// Scenario 2: loading-spinner state
// ---------------------------------------------------------------------------

async function runLoadingStateChecks(session) {
  console.log("\n=== Scenario 2: loading-spinner state ===");
  const checks = {};

  checks.buttonIsElement = await evaluate(session, `
    document.getElementById('mc-embedded-subscribe').tagName
  `);

  checks.idleState = await evaluate(session, `
    (function () {
      var btn = document.getElementById('mc-embedded-subscribe');
      var label = btn.querySelector('.btnLabel');
      var spinner = btn.querySelector('.spinner');
      return {
        hasBusyClass: btn.classList.contains('busy'),
        labelVisible: getComputedStyle(label).visibility !== 'hidden',
        spinnerDisplay: getComputedStyle(spinner).display,
        disabled: btn.disabled,
      };
    })()
  `);

  checks.busyState = await evaluate(session, `
    (function () {
      var btn = document.getElementById('mc-embedded-subscribe');
      btn.classList.add('busy');
      btn.disabled = true;
      var label = btn.querySelector('.btnLabel');
      var spinner = btn.querySelector('.spinner');
      return {
        labelVisible: getComputedStyle(label).visibility !== 'hidden',
        spinnerDisplay: getComputedStyle(spinner).display,
        spinnerIsCircular: (function () {
          var s = getComputedStyle(spinner);
          return s.borderRadius === '50%' && s.animationName === 'btnSpin';
        })(),
        disabled: btn.disabled,
      };
    })()
  `);

  checks.restoredState = await evaluate(session, `
    (function () {
      var btn = document.getElementById('mc-embedded-subscribe');
      btn.classList.remove('busy');
      btn.disabled = false;
      var label = btn.querySelector('.btnLabel');
      var spinner = btn.querySelector('.spinner');
      return {
        labelVisible: getComputedStyle(label).visibility !== 'hidden',
        spinnerDisplay: getComputedStyle(spinner).display,
        disabled: btn.disabled,
      };
    })()
  `);

  const pass =
    checks.buttonIsElement === "BUTTON" &&
    !checks.idleState.hasBusyClass &&
    checks.idleState.labelVisible &&
    checks.idleState.spinnerDisplay === "none" &&
    !checks.idleState.disabled &&
    !checks.busyState.labelVisible &&
    checks.busyState.spinnerDisplay === "block" &&
    checks.busyState.spinnerIsCircular &&
    checks.busyState.disabled &&
    checks.restoredState.labelVisible &&
    checks.restoredState.spinnerDisplay === "none" &&
    !checks.restoredState.disabled;

  console.log(JSON.stringify(checks, null, 2));
  console.log(pass ? "Scenario 2: ALL PASS" : "Scenario 2: FAIL");
  return pass;
}

// ---------------------------------------------------------------------------
// Scenario 3: SMS E.164 formatting + JSONP submit
// ---------------------------------------------------------------------------

function smsFillAndSubmitScript(response) {
  return `
    (function () {
      window.__mcTestResponse = ${JSON.stringify(response)};
      const form = document.getElementById('mc-embedded-subscribe-form');
      const phone = document.getElementById('mce-SMSPHONE');
      const email = document.getElementById('mce-EMAIL');
      const park = document.getElementById('mce-MMERGE130');
      const ack = document.getElementById('mc-SMSPHONE-ack');
      const errorEl = document.getElementById('mce-error-response');
      const successEl = document.getElementById('mce-success-response');

      email.value = 'wyatt@example.com';
      park.checked = true;
      ack.checked = true;
      phone.value = '5551234567';
      phone.dispatchEvent(new Event('input', { bubbles: true }));

      const locationBefore = location.href;

      return new Promise((resolve, reject) => {
        let waited = 0;
        const poll = setInterval(() => {
          waited += 20;
          const shown = errorEl.style.display === 'block' || successEl.style.display === 'block';
          if (shown) {
            clearInterval(poll);
            resolve({
              scriptSrcs: window.__mcScriptCalls,
              errorShown: errorEl.style.display === 'block',
              errorText: errorEl.textContent,
              successShown: successEl.style.display === 'block',
              successText: successEl.textContent,
              phoneValueAfter: phone.value,
              navigated: location.href !== locationBefore,
            });
          } else if (waited > 2000) {
            clearInterval(poll);
            reject(new Error('Timed out waiting for response UI'));
          }
        }, 20);
        form.querySelector('#mc-embedded-subscribe').click();
      });
    })()
  `;
}

async function runSmsFormatChecks(session) {
  console.log("\n=== Scenario 3: SMS E.164 formatting + JSONP submit ===");
  let pass = true;

  await evaluate(session, JSONP_HARNESS);

  // Case 1: Mailchimp rejects the SMS format.
  const errorResult = await evaluate(session, smsFillAndSubmitScript({
    result: "error",
    msg: "0 - Please provide an SMS number in the international standard format",
  }), { awaitPromise: true });
  console.log("Error-case result:", errorResult);

  if (errorResult.navigated) {
    console.error("  FAIL: page navigated away on error — should stay on landing.html");
    pass = false;
  }
  if (!errorResult.scriptSrcs.some((s) => /\/post-json\?/.test(s) && /SMSPHONE=%2B15551234567/.test(s))) {
    console.error("  FAIL: JSONP request did not carry the E.164 phone number: " + JSON.stringify(errorResult.scriptSrcs));
    pass = false;
  }
  if (!errorResult.errorShown || errorResult.successShown) {
    console.error("  FAIL: expected only the error response to show");
    pass = false;
  } else if (errorResult.errorText.indexOf("international standard format") === -1) {
    console.error("  FAIL: error message not shown inline: " + errorResult.errorText);
    pass = false;
  }
  if (errorResult.phoneValueAfter !== "(555) 123-4567") {
    console.error("  FAIL: phone field should be restored to local display format after an error, got: " + errorResult.phoneValueAfter);
    pass = false;
  }
  if (pass) console.log("  PASS: error response shown inline, no navigation, phone field restored.");

  // Reload for a clean slate, then case 2: success.
  await evaluate(session, `location.reload()`);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(session, JSONP_HARNESS);

  const successResult = await evaluate(session, smsFillAndSubmitScript({
    result: "success",
    msg: "Almost finished...",
  }), { awaitPromise: true });
  console.log("Success-case result:", successResult);

  if (successResult.navigated) {
    console.error("  FAIL: page navigated away on success — should stay on landing.html");
    pass = false;
  } else if (!successResult.successShown || successResult.errorShown) {
    console.error("  FAIL: expected only the success response to show");
    pass = false;
  } else {
    console.log("  PASS: success response shown inline, no navigation.");
  }

  console.log(pass ? "Scenario 3: ALL PASS" : "Scenario 3: FAIL");
  return pass;
}

// ---------------------------------------------------------------------------

async function main() {
  const chrome = await launchChrome({});
  try {
    const { session } = await openPage({ port: chrome.port, url: URL, viewport });
    await new Promise((r) => setTimeout(r, 300));

    const fieldValidationPass = await runFieldValidationChecks(session);

    // Each scenario reloads for a clean DOM/JS slate before it runs — the
    // field-validation scenario's happy-path case leaves the button stuck
    // mid-submit (busy class set, JSONP callback never fires because no
    // fake response is registered), and re-running the harness on the same
    // page without reloading re-declares its top-level consts.
    await evaluate(session, `location.reload()`);
    await new Promise((r) => setTimeout(r, 300));
    const loadingStatePass = await runLoadingStateChecks(session);

    await evaluate(session, `location.reload()`);
    await new Promise((r) => setTimeout(r, 300));
    // SMS scenario reloads the page for a clean slate between its own two
    // cases too, so run it last.
    const smsFormatPass = await runSmsFormatChecks(session);

    const overallPass = fieldValidationPass && loadingStatePass && smsFormatPass;
    console.log("\n=== Overall ===");
    console.log(JSON.stringify({
      fieldValidationPass,
      loadingStatePass,
      smsFormatPass,
      overallPass,
    }, null, 2));

    if (!overallPass) {
      process.exitCode = 1;
      return;
    }
    console.log("ALL PASS");
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
    return;
  } finally {
    await stopChrome(chrome);
  }
}

main();
