// ── Shared form helpers ───────────────────────────────────────────────────────

// flagFieldError highlights the field, shakes it, shows the message and puts
// the cursor back in the field so the participant can correct it immediately.
// A field drawn by a wrapper (marked data-field-frame, e.g. the passcode
// slots) gets the visual error state on that wrapper instead of the input.
function flagFieldError(input, message) {
  setMessage('message', message, true);
  if (!input) return;
  const frame = input.closest('[data-field-frame]') || input;
  frame.classList.remove('field-shake');
  void frame.offsetWidth; // restart the animation
  frame.classList.add('field-error', 'field-shake');
  input.focus();
  if (frame === input) input.select?.();
}

// Clear the error styling as soon as the participant starts typing again.
function clearErrorOnInput(input) {
  input?.addEventListener('input', () => {
    (input.closest('[data-field-frame]') || input).classList.remove('field-error');
    const msg = document.getElementById('message');
    if (msg) { msg.textContent = ''; msg.className = 'mt-3'; }
  });
}

// ── Passcode validation form (index.html) ─────────────────────────────────────
// Step 1 of the participant flow. The participant enters the passcode distributed
// by the administrator. On success the passcode_id is stored in localStorage so
// the registration page can reference it, and the browser redirects to register.html.
//
// Passcodes are always "DAES-" + 8 hex characters (see uniquePasscode in
// handlers/passcode_handler.go). The page shows the fixed prefix and the
// participant types only the 8 characters, displayed in individual slots.
const PASSCODE_PREFIX = 'DAES-';
const PASSCODE_LENGTH = 8;

// normalizePasscode turns whatever was typed or pasted into the 8-character
// body: upper-cases it, drops a pasted "DAES-" prefix, corrects look-alike
// characters that cannot occur in a hex code (O→0, I/L→1) and discards
// anything else.
function normalizePasscode(raw) {
  let v = String(raw || '').toUpperCase().replace(/\s+/g, '');
  v = v.replace(/^DAES[-–—]?/, '');
  v = v.replace(/O/g, '0').replace(/[IL]/g, '1');
  return v.replace(/[^0-9A-F]/g, '').slice(0, PASSCODE_LENGTH);
}

const passcodeForm = document.getElementById('passcodeForm');
if (passcodeForm) {
  const codeInput = document.getElementById('code');
  const codeField = document.getElementById('codeField');
  const slots     = [...document.querySelectorAll('#codeField .slot')];
  let lastAutoSubmitted = '';

  // Draw the typed characters into the slots and mark the active one.
  const renderSlots = (popIndex = -1) => {
    const v = codeInput.value;
    slots.forEach((slot, i) => {
      slot.textContent = v[i] || '';
      slot.classList.toggle('filled', i < v.length);
      slot.classList.toggle('active', i === Math.min(v.length, PASSCODE_LENGTH - 1));
      slot.classList.toggle('pop', i === popIndex);
    });
    codeField?.classList.toggle('is-complete', v.length === PASSCODE_LENGTH);
  };

  // Characters are always added/removed at the end, like a PIN pad.
  const caretToEnd = () => {
    const n = codeInput.value.length;
    try { codeInput.setSelectionRange(n, n); } catch { /* not supported */ }
  };

  codeInput.addEventListener('input', () => {
    const before = codeInput.value;
    const v = normalizePasscode(before);
    const grew = v.length > (codeInput.dataset.prevLen | 0);
    codeInput.value = v;
    codeInput.dataset.prevLen = v.length;
    renderSlots(grew ? v.length - 1 : -1);
    caretToEnd();

    // Submit automatically once the code is complete. Each completion
    // submits once; editing the code (making it incomplete) re-arms it.
    if (v.length < PASSCODE_LENGTH) lastAutoSubmitted = '';
    if (v.length === PASSCODE_LENGTH && v !== lastAutoSubmitted) {
      lastAutoSubmitted = v;
      if (typeof passcodeForm.requestSubmit === 'function') passcodeForm.requestSubmit();
      else passcodeForm.querySelector('[type=submit]')?.click();
    }
  });
  codeInput.addEventListener('focus', () => { codeField?.classList.add('is-focused'); caretToEnd(); });
  codeInput.addEventListener('blur',  () => codeField?.classList.remove('is-focused'));
  codeInput.addEventListener('click', caretToEnd);
  codeInput.addEventListener('keyup', caretToEnd);

  clearErrorOnInput(codeInput);

  // Coming back from the CID page because the passcode was missing, invalid
  // or expired: explain why and ask for it again.
  let notice = null;
  try { notice = sessionStorage.getItem('passcode_notice'); sessionStorage.removeItem('passcode_notice'); } catch {}

  // The browser may restore a previous value (back button / autofill).
  codeInput.value = normalizePasscode(codeInput.value);
  codeInput.dataset.prevLen = codeInput.value.length;
  renderSlots();
  codeInput.focus();
  if (notice) flagFieldError(codeInput, notice);

  passcodeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = normalizePasscode(codeInput.value);
    if (!body) { flagFieldError(codeInput, 'Please enter the passcode.'); return; }
    if (body.length < PASSCODE_LENGTH) {
      const missing = PASSCODE_LENGTH - body.length;
      flagFieldError(codeInput, `Please enter all ${PASSCODE_LENGTH} characters (${missing} missing).`);
      return;
    }
    const code = PASSCODE_PREFIX + body;

    await withBusy(e.submitter || passcodeForm.querySelector('[type=submit]'), async () => {
      try {
        const data = await api('/api/validate-passcode', {
          method: 'POST',
          body: JSON.stringify({ code }),
        });
        localStorage.setItem('passcode_id', data.passcode_id);
        setMessage('message', 'Passcode accepted. Redirecting…');
        window.location.href = 'register.html';
        return withBusy.KEEP;
      } catch (err) {
        flagFieldError(codeInput, err instanceof TypeError
          ? 'Unable to reach the server. Please check your connection and try again.'
          : err.message);
      }
    }, 'Checking…');
  });
}

// ── CID validation form (register.html) ───────────────────────────────────────
// Step 2 of the participant flow. The participant enters their CID number, which
// must match a pre-registered participant record. On success the participant_id
// is stored in localStorage (used by the test page to identify the participant
// for submission), any previous timer is cleared, and the browser moves to the
// instructions page.
const CID_DIGITS = 11; // standard CID length, used only for the digit counter

// sendBackToPasscode returns the participant to the passcode page with a
// message, forgetting the stored passcode so they must enter it again.
function sendBackToPasscode(message) {
  localStorage.removeItem('passcode_id');
  try { sessionStorage.setItem('passcode_notice', message); } catch { /* storage blocked */ }
  window.location.replace('index.html');
}

const cidForm = document.getElementById('cidForm');
if (cidForm) {
  // The passcode must be verified before the CID page can be used. Without
  // one, go straight back; with one, confirm with the server that it is still
  // valid (not expired or deleted) before the participant types their CID.
  // The server enforces the same rule again when the CID is submitted.
  const storedPasscodeId = Number(localStorage.getItem('passcode_id'));
  if (!storedPasscodeId) {
    sendBackToPasscode('Please enter your passcode first.');
  } else {
    fetch(`/api/passcode-status/${storedPasscodeId}?active=1`)
      .then(res => res.json())
      .then(data => {
        if (data && data.valid === false) {
          sendBackToPasscode('Your passcode is invalid or has expired. Please enter it again.');
        }
      })
      .catch(() => { /* Offline or server error: the check repeats on submit. */ });
  }

  const cidInput   = document.getElementById('cid_number');
  const cidField   = document.getElementById('cidField');
  const cidCounter = document.getElementById('cidCounter');
  const cidClear   = document.getElementById('cidClear');

  // Live feedback: spaces are removed as they are typed (a CID never contains
  // them), and a digit counter shows how many digits have been entered.
  // Non-numeric IDs (e.g. permit numbers) are allowed; the counter just hides.
  const updateCidUi = () => {
    const v = cidInput.value;
    const numeric = /^\d*$/.test(v);
    if (cidCounter) {
      cidCounter.hidden = !numeric;
      cidCounter.textContent = `${v.length}/${CID_DIGITS}`;
      cidCounter.classList.toggle('ok',   numeric && v.length === CID_DIGITS);
      cidCounter.classList.toggle('over', numeric && v.length > CID_DIGITS);
    }
    cidField?.classList.toggle('is-valid', numeric && v.length === CID_DIGITS);
    if (cidClear) cidClear.hidden = v.length === 0;
  };

  cidInput.addEventListener('input', () => {
    const cleaned = cidInput.value.replace(/\s+/g, '');
    if (cleaned !== cidInput.value) cidInput.value = cleaned;
    updateCidUi();
  });
  cidClear?.addEventListener('click', () => {
    cidInput.value = '';
    cidInput.dispatchEvent(new Event('input'));
    cidInput.focus();
  });

  clearErrorOnInput(cidInput);
  updateCidUi();
  cidInput?.focus();

  cidForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const passcodeId = localStorage.getItem('passcode_id');
    if (!passcodeId) { window.location.href = 'index.html'; return; }

    const cid = cidInput.value.trim();
    if (!cid) { flagFieldError(cidInput, 'Please enter your CID number.'); return; }

    const button = e.submitter || cidForm.querySelector('[type=submit]');
    await withBusy(button, async () => {
      try {
        const data = await api('/api/validate-cid', {
          method: 'POST',
          body: JSON.stringify({ cid_number: cid, passcode_id: Number(passcodeId) }),
        });

        localStorage.setItem('participant_id', data.participant_id);
        localStorage.setItem('participant_token', data.participant_token || '');
        localStorage.setItem('participant_name', data.full_name  || '');
        localStorage.setItem('participant_cid',  data.cid_number || '');
        // Clear any leftover timer from a previous session so the clock starts fresh
        // when the participant reaches the test page.
        localStorage.removeItem('test_start_time');

        // Confirm who was recognised for a moment before moving on, so a
        // participant who typed someone else's CID notices.
        const name = data.full_name ? `, ${data.full_name}` : '';
        button.innerHTML = '<span aria-hidden="true">&#10003;</span><span>Verified</span>';
        button.style.background = 'linear-gradient(135deg, #16a34a, #0d9488)';
        setMessage('message', `Welcome${name}! Taking you to the instructions…`);
        setTimeout(() => { window.location.href = 'instructions.html'; }, 900);
        return withBusy.KEEP;
      } catch (err) {
        if (err.data?.code === 'passcode_invalid') {
          sendBackToPasscode(err.message);
          return withBusy.KEEP;
        }
        flagFieldError(cidInput, err instanceof TypeError
          ? 'Unable to reach the server. Please check your connection and try again.'
          : err.message);
      }
    }, 'Verifying…');
  });
}
