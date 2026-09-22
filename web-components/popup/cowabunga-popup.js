/**
 * Cowabunga: Wild Rush promo popup — standalone, embeddable snippet.
 *
 * Drop this one file onto any cowabungavegas.com page as a plain
 * <script src>, or paste `oxygen-code-block.html`'s tiny wrapper into an
 * Oxygen Code Block — no markup needs to exist on the host page already,
 * and it loads its own CSS (`cowabunga-popup.css`, expected alongside this
 * file — override via config.cssUrl if it's hosted somewhere else) and its
 * own Google Fonts (Luckiest Guy / Grandstander / Quicksand — the same
 * family index.html loads) rather than assuming the host page already has
 * either, since this popup can be embedded on pages outside the game
 * itself where that isn't guaranteed.
 *
 * Optional config — set before this script runs:
 *   window.COWABUNGA_POPUP_CONFIG = {
 *     ctaUrl: '/cowabunga-wild-rush/',
 *     delayMs: 6000,
 *     suppressDays: 1,
 *     cssUrl: '...',
 *     phoneImageUrl: '...',
 *     phoneImageWebpUrl: '...'
 *   };
 */
(function () {
  'use strict';

  var FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Grandstander:wght@700;800&family=Quicksand:wght@500;600&display=swap';

  function ensureFontsLoaded() {
    if (document.querySelector('link[href="' + FONTS_HREF + '"]')) return;
    var preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = 'https://fonts.gstatic.com';
    preconnect.crossOrigin = 'anonymous';
    document.head.appendChild(preconnect);

    var stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = FONTS_HREF;
    document.head.appendChild(stylesheet);
  }

  // Keeps this file and cowabunga-popup.css as one thing to re-sync instead
  // of two separate <link>/<script> tags a host page has to remember to
  // keep paired — inject it the same way ensureFontsLoaded() injects the
  // Google Fonts link.
  function ensurePopupCssLoaded(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = href;
    document.head.appendChild(stylesheet);
  }

  // document.currentScript is only valid during this script's own
  // synchronous execution, so grab it now — by the time init() runs
  // (possibly after a DOMContentLoaded wait) it's already null.
  var scriptDir = document.currentScript
    ? document.currentScript.src.replace(/[^/]*$/, '')
    : '';

  var config = Object.assign({
    ctaUrl: '/cowabunga-wild-rush/',
    delayMs: 6000,
    suppressDays: 1,
    // Defaults assume the repo's own web-components/popup + assets/popup
    // layout is preserved on deploy; a host page elsewhere on
    // cowabungavegas.com should pass the uploaded media URLs instead.
    cssUrl: scriptDir + 'cowabunga-popup.css',
    phoneImageUrl: scriptDir + '../../assets/popup/Phone.png',
    phoneImageWebpUrl: scriptDir + '../../assets/popup/Phone.webp'
  }, window.COWABUNGA_POPUP_CONFIG || {});

  var STORAGE_KEY = 'cwrPopupLastShown';

  function alreadyShownRecently() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      // Storage can throw in private-browsing/locked-down contexts —
      // fail open (show the popup) rather than break the host page.
      return false;
    }
    if (!raw) return false;
    var lastShown = parseInt(raw, 10);
    if (!lastShown) return false;
    var elapsedMs = Date.now() - lastShown;
    return elapsedMs < config.suppressDays * 24 * 60 * 60 * 1000;
  }

  function rememberShown() {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch (err) {
      // Ignore — worst case the popup reappears next visit.
    }
  }

  function buildPopup() {
    var root = document.createElement('div');
    root.className = 'cwr-popup';
    root.setAttribute('hidden', '');
    root.innerHTML =
      '<div class="cwr-popup__backdrop" data-cwr-dismiss></div>' +
      '<div class="cwr-popup__dialog" role="dialog" aria-modal="true" aria-labelledby="cwrPopupTitle">' +
      '  <button type="button" class="cwr-popup__close" data-cwr-dismiss aria-label="Close">&times;</button>' +
      '  <div class="cwr-popup__content">' +
      '    <div class="cwr-popup__media">' +
      '      <picture>' +
      '        <source srcset="' + config.phoneImageWebpUrl + '" type="image/webp">' +
      '        <img class="cwr-popup__phone" src="' + config.phoneImageUrl + '" width="400" height="681" ' +
      '             alt="Cowabunga: Wild Rush gameplay preview on a phone" loading="lazy">' +
      '      </picture>' +
      '    </div>' +
      '    <div class="cwr-popup__copy">' +
      '      <h2 class="cwr-popup__title" id="cwrPopupTitle">' +
      '        <span class="cwr-popup__rideLine">Join.</span>' +
      '        <span class="cwr-popup__rideLine">Play.</span>' +
      '        <span class="cwr-popup__rideLine">Save.</span>' +
      '      </h2>' +
      '      <p class="cwr-popup__body">Sign up for email &amp; SMS and get instant access to the official Cowabunga: Wild Rush game, ' +
      '<strong>plus $10 off</strong> your next Cowabunga Vegas online purchase.</p>' +
      '      <a class="cwr-popup__cta" href="' + config.ctaUrl + '">Play Now &amp; Save $10</a>' +
      '      <p class="cwr-popup__fine">Msg &amp; data rates may apply for SMS. Unsubscribe anytime.</p>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    return root;
  }

  function init() {
    ensureFontsLoaded();
    ensurePopupCssLoaded(config.cssUrl);

    var popup = buildPopup();
    document.body.appendChild(popup);

    var dialog = popup.querySelector('.cwr-popup__dialog');
    var focusableSelector = 'a[href], button:not([disabled])';
    var previouslyFocused = null;

    function focusableEls() {
      return Array.prototype.slice.call(dialog.querySelectorAll(focusableSelector));
    }

    function trapFocus(e) {
      if (e.key !== 'Tab') return;
      var els = focusableEls();
      if (!els.length) return;
      var first = els[0];
      var last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        close();
      } else {
        trapFocus(e);
      }
    }

    function open() {
      previouslyFocused = document.activeElement;
      popup.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onKeydown);
      var els = focusableEls();
      if (els.length) els[0].focus();
      rememberShown();
    }

    function close() {
      popup.setAttribute('hidden', '');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeydown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    }

    popup.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-cwr-dismiss')) close();
    });

    // Exposed for manual testing / re-triggering from other UI (e.g. a
    // "get $10 off" link elsewhere on the page) — available regardless of
    // whether the automatic auto-open below is suppressed, so a manual
    // trigger always works even on a repeat visit within suppressDays.
    window.CowabungaPopup = { open: open, close: close };

    if (!alreadyShownRecently()) {
      window.setTimeout(open, config.delayMs);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
