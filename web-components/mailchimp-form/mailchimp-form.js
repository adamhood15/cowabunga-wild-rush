(function () {
  var form = document.getElementById('mc-embedded-subscribe-form');
  var submitButton = document.getElementById('mc-embedded-subscribe');
  var phone = document.getElementById('mce-SMSPHONE');
  var countrySelect = document.getElementById('country-select-SMSPHONE');
  var errorEl = document.getElementById('mce-error-response');
  var successEl = document.getElementById('mce-success-response');
  var emailInput = document.getElementById('mce-EMAIL');
  var ackCheckbox = document.getElementById('mc-SMSPHONE-ack');

  // Mailchimp's SMS field wants the submitted value in E.164
  // (+15555550100), not the local display format we mask the input to —
  // its own embed JS normally does this conversion, but we hand-styled
  // the raw markup without that script, so we do it ourselves on submit.
  var callingCodes = { US: '1' };

  // A real POST to the form's action navigates the browser to whatever
  // list-manage.com sends back — on a validation error that lands the
  // customer on Mailchimp's own error/preference-center page, away from
  // the site entirely. Submitting the same fields via JSONP instead keeps
  // them on landing.html and lets us show the response inline in the
  // #mce-error-response / #mce-success-response divs the markup already
  // has for exactly this.
  function submitViaJsonp(form) {
    return new Promise(function (resolve, reject) {
      var callbackName = 'mcJsonpCallback_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var params = new URLSearchParams();
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.disabled) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) params.append(el.name, el.value);
        } else if (el.type !== 'submit' && el.type !== 'button') {
          params.append(el.name, el.value);
        }
      });
      params.append('c', callbackName);

      var script = document.createElement('script');
      script.src = form.action.replace('/post?', '/post-json?') + '&' + params.toString();

      function cleanup() {
        delete window[callbackName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[callbackName] = function (data) {
        cleanup();
        resolve(data);
      };
      script.onerror = function () {
        cleanup();
        reject(new Error('Network error contacting Mailchimp'));
      };

      document.body.appendChild(script);
    });
  }

  function showResponse(el, message) {
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    el.textContent = message;
    el.style.display = 'block';
  }

  function fieldGroup(el) {
    return el.closest('.mc-field-group') || el.closest('.mc-sms-phone-group');
  }

  function clearFieldError(groupEl) {
    var el = groupEl.querySelector('.mc-field-error');
    if (el) el.classList.remove('is-visible');
  }

  function setFieldError(groupEl, message) {
    var el = groupEl.querySelector('.mc-field-error');
    if (!el) {
      el = document.createElement('div');
      el.className = 'mc-field-error';
      groupEl.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-visible');
  }

  // One validator per required input — each shows its own message next to
  // its own field, so a customer missing multiple fields sees all of them
  // at once instead of one generic error / a native tooltip on just the
  // first invalid field.
  var VALIDATORS = [
    {
      groupEl: fieldGroup(emailInput),
      check: function () {
        return emailInput.value.trim() !== '' && emailInput.checkValidity();
      },
      message: 'Please enter a valid email address.',
    },
    {
      groupEl: fieldGroup(phone),
      check: function () {
        return /^\(\d{3}\) \d{3}-\d{4}$/.test(phone.value);
      },
      message: 'Please enter a valid 10-digit phone number.',
    },
    {
      groupEl: fieldGroup(ackCheckbox),
      check: function () {
        return ackCheckbox.checked;
      },
      message: 'Please check the box to continue.',
    },
  ];

  function validateForm() {
    var valid = true;
    var firstInvalidGroup = null;
    VALIDATORS.forEach(function (v) {
      if (v.check()) {
        clearFieldError(v.groupEl);
      } else {
        setFieldError(v.groupEl, v.message);
        valid = false;
        if (!firstInvalidGroup) firstInvalidGroup = v.groupEl;
      }
    });
    if (firstInvalidGroup) {
      firstInvalidGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return valid;
  }

  emailInput.addEventListener('input', function () {
    if (emailInput.value.trim() !== '' && emailInput.checkValidity()) {
      clearFieldError(fieldGroup(emailInput));
    }
  });
  ackCheckbox.addEventListener('change', function () {
    if (ackCheckbox.checked) clearFieldError(fieldGroup(ackCheckbox));
  });

  function formatPhone(digits) {
    if (digits.length === 0) return '';
    if (digits.length < 4) return '(' + digits;
    if (digits.length < 7) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  var phoneDigitCount = 0;
  phone.addEventListener('input', function (e) {
    var digits = phone.value.replace(/\D/g, '').slice(0, 10);
    // Backspacing over a mask character (e.g. the ")") deletes only that
    // character, leaving digit count unchanged, so re-formatting would just
    // put the same character right back — drop a digit too so backspace
    // still does something.
    if (e.inputType === 'deleteContentBackward' && digits.length === phoneDigitCount) {
      digits = digits.slice(0, -1);
    }
    phoneDigitCount = digits.length;
    phone.value = formatPhone(digits);
    if (/^\(\d{3}\) \d{3}-\d{4}$/.test(phone.value)) {
      clearFieldError(fieldGroup(phone));
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validateForm()) return;

    var localPhoneValue = phone.value;
    var digits = phone.value.replace(/\D/g, '');
    var code = callingCodes[countrySelect.value] || '1';
    phone.value = '+' + code + digits;

    submitButton.classList.add('busy');
    submitButton.disabled = true;

    submitViaJsonp(form).then(function (data) {
      if (data.result === 'success') {
        showResponse(successEl, 'Thanks — check your phone/email for your promo code!');
        // redirectToGame()'s own opt-in check reads mce-EMAIL/mc-SMSPHONE-ack,
        // so it must run before form.reset() clears them. Busy state is
        // left on here — the page is about to navigate away.
        if (window.WaterparkGate && typeof window.WaterparkGate.redirectToGame === 'function') {
          window.WaterparkGate.redirectToGame();
        } else {
          submitButton.classList.remove('busy');
          submitButton.disabled = false;
          form.reset();
        }
      } else {
        // Mailchimp prefixes error text with a numeric code, e.g. "0 - ...".
        var message = String(data.msg || 'Something went wrong. Please try again.')
          .replace(/^\d+\s*-\s*/, '')
          .replace(/<[^>]*>/g, '');
        phone.value = localPhoneValue;
        submitButton.classList.remove('busy');
        submitButton.disabled = false;
        showResponse(errorEl, message);
      }
    }, function () {
      phone.value = localPhoneValue;
      submitButton.classList.remove('busy');
      submitButton.disabled = false;
      showResponse(errorEl, 'Something went wrong reaching Mailchimp. Please try again.');
    });
  });
})();
