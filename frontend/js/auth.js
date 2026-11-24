// ── Shared form helpers ───────────────────────────────────────────────────────

// flagFieldError highlights the input, shakes it, shows the message and puts
// the cursor back in the field so the participant can correct it immediately.
function flagFieldError(input, message) {
  setMessage('message', message, true);
  if (!input) return;
  input.classList.remove('field-shake');
  void input.offsetWidth; // restart the animation
  input.classList.add('field-error', 'field-shake');
  input.focus();
  input.select?.();
}

// Clear the error styling as soon as the participant starts typing again.
function clearErrorOnInput(input) {
  input?.addEventListener('input', () => {
    input.classList.remove('field-error');
    const msg = document.getElementById('message');
    if (msg) { msg.textContent = ''; msg.className = 'mt-3'; }
  });
}

// ── Passcode validation form (index.html) ─────────────────────────────────────
// Step 1 of the participant flow. The participant enters the passcode distributed
// by the administrator. On success the passcode_id is stored in localStorage so
// the registration page can reference it, and the browser redirects to register.html.
const passcodeForm = document.getElementById('passcodeForm');
if (passcodeForm) {
  const codeInput = document.getElementById('code');
  clearErrorOnInput(codeInput);
  codeInput?.focus();

  passcodeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!code) { flagFieldError(codeInput, 'Please enter the passcode.'); return; }

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
const cidForm = document.getElementById('cidForm');
if (cidForm) {
  // Send the participant back to step 1 now, rather than after they have
  // typed their CID, if they arrived here without passing the passcode gate.
  if (!localStorage.getItem('passcode_id')) window.location.replace('index.html');

  const cidInput = document.getElementById('cid_number');
  clearErrorOnInput(cidInput);
  cidInput?.focus();

  cidForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const passcodeId = localStorage.getItem('passcode_id');
    if (!passcodeId) { window.location.href = 'index.html'; return; }

    const cid = cidInput.value.trim();
    if (!cid) { flagFieldError(cidInput, 'Please enter your CID number.'); return; }

    await withBusy(e.submitter || cidForm.querySelector('[type=submit]'), async () => {
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
        setMessage('message', `Welcome${data.full_name ? ', ' + data.full_name : ''}! Redirecting…`);
        window.location.href = 'instructions.html';
        return withBusy.KEEP;
      } catch (err) {
        flagFieldError(cidInput, err instanceof TypeError
          ? 'Unable to reach the server. Please check your connection and try again.'
          : err.message);
      }
    }, 'Verifying…');
  });
}
