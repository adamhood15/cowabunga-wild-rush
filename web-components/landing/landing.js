(function () {
  var form = document.getElementById('signupForm');
  var optErr = document.getElementById('optErr');
  var doneCard = document.getElementById('doneCard');
  var doneChannel = document.getElementById('doneChannel');

  function formatPhone(digits) {
    if (digits.length === 0) return '';
    if (digits.length < 4) return '(' + digits;
    if (digits.length < 7) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  var phoneDigitCount = 0;
  form.phone.addEventListener('input', function (e) {
    var digits = form.phone.value.replace(/\D/g, '').slice(0, 10);
    // Backspacing over a mask character (e.g. the ")") deletes only that
    // character, leaving digit count unchanged, so re-formatting would just
    // put the same character right back — drop a digit too so backspace
    // still does something.
    if (e.inputType === 'deleteContentBackward' && digits.length === phoneDigitCount) {
      digits = digits.slice(0, -1);
    }
    phoneDigitCount = digits.length;
    form.phone.value = formatPhone(digits);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!form.reportValidity()) return;

    var byEmail = form.optEmail.checked;
    var bySms = form.optSms.checked;

    if (!byEmail && !bySms) {
      optErr.hidden = false;
      return;
    }
    optErr.hidden = true;

    doneChannel.textContent = byEmail && bySms ? 'by email and text'
      : bySms ? 'by text'
      : 'by email';

    form.hidden = true;
    doneCard.hidden = false;
  });
})();
