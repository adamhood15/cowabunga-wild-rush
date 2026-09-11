/**
 * Cowabunga: Wild Rush promo popup — standalone, embeddable snippet.
 *
 * Drop `stampede-popup.css` + this file onto any typhoontexas.com page
 * (e.g. via a plain <link>/<script> pair, or through GTM) and it injects
 * itself — no markup needs to exist on the host page already.
 *
 * Assumes the site's Typekit kit (cmv0fio.css — sutro-deluxe-primary,
 * sutro-open-fill, sutro) is already loaded site-wide; this snippet does
 * not load it itself. Note the kit does not include sutro-deluxe-fill, so
 * the .swr-popup__rideLine::before fill layer (see stampede-popup.css)
 * falls back to sutro-deluxe-primary too.
 *
 * Optional config — set before this script runs:
 *   window.STAMPEDE_POPUP_CONFIG = {
 *     ctaUrl: 'https://typhoontexas.com/stampede-wild-rush/',
 *     delayMs: 6000,
 *     suppressDays: 1,
 *     phoneImageUrl: '...',
 *     phoneImageWebpUrl: '...'
 *   };
 */
(function () {
  'use strict';

  // document.currentScript is only valid during this script's own
  // synchronous execution, so grab it now — by the time init() runs
  // (possibly after a DOMContentLoaded wait) it's already null.
  var scriptDir = document.currentScript
    ? document.currentScript.src.replace(/[^/]*$/, '')
    : '';

  var config = Object.assign({
    ctaUrl: 'https://typhoontexas.com/stampede-wild-rush/',
    delayMs: 6000,
    suppressDays: 1,
    // Defaults assume the repo's own web-components/popup + assets/popup
    // layout is preserved on deploy; a host page elsewhere on
    // typhoontexas.com should pass the uploaded media URLs instead.
    phoneImageUrl: scriptDir + '../../assets/popup/Phone.png',
    phoneImageWebpUrl: scriptDir + '../../assets/popup/Phone.webp'
  }, window.STAMPEDE_POPUP_CONFIG || {});

  var STORAGE_KEY = 'swrPopupLastShown';

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
    root.className = 'swr-popup';
    root.setAttribute('hidden', '');
    root.innerHTML =
      '<div class="swr-popup__backdrop" data-swr-dismiss></div>' +
      '<div class="swr-popup__dialog" role="dialog" aria-modal="true" aria-labelledby="swrPopupTitle">' +
      '  <button type="button" class="swr-popup__close" data-swr-dismiss aria-label="Close">&times;</button>' +
      '  <div class="swr-popup__content">' +
      '    <div class="swr-popup__media">' +
      '      <picture>' +
      '        <source srcset="' + config.phoneImageWebpUrl + '" type="image/webp">' +
      '        <img class="swr-popup__phone" src="' + config.phoneImageUrl + '" width="400" height="681" ' +
      '             alt="Cowabunga: Wild Rush gameplay preview on a phone" loading="lazy">' +
      '      </picture>' +
      '    </div>' +
      '    <div class="swr-popup__copy">' +
      '      <h2 class="swr-popup__title" id="swrPopupTitle">' +
      '        <span class="swr-popup__rideLine" data-text="Join.">Join.</span>' +
      '        <span class="swr-popup__rideLine" data-text="Play.">Play.</span>' +
      '        <span class="swr-popup__rideLine" data-text="Save.">Save.</span>' +
      '      </h2>' +
      '      <p class="swr-popup__body">Sign up for email &amp; SMS and get instant access to the official Typhoon Texas water slide game, ' +
      '<strong>plus $10 off</strong> your next Typhoon Texas online purchase.</p>' +
      '      <a class="swr-popup__cta" href="' + config.ctaUrl + '">Play Now &amp; Save $10</a>' +
      '      <p class="swr-popup__fine">Msg &amp; data rates may apply for SMS. Unsubscribe anytime.</p>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    return root;
  }

  function init() {
    var popup = buildPopup();
    document.body.appendChild(popup);

    var dialog = popup.querySelector('.swr-popup__dialog');
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
      if (e.target.hasAttribute('data-swr-dismiss')) close();
    });

    // Exposed for manual testing / re-triggering from other UI (e.g. a
    // "get $10 off" link elsewhere on the page) — available regardless of
    // whether the automatic auto-open below is suppressed, so a manual
    // trigger always works even on a repeat visit within suppressDays.
    window.StampedePopup = { open: open, close: close };

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
