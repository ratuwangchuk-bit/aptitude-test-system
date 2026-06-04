// ── Passcode validation form (index.html) ─────────────────────────────────────
// Step 1 of the participant flow. The participant enters the passcode distributed
// by the administrator. On success the passcode_id is stored in localStorage so
// the registration page can reference it, and the browser redirects to register.html.
document.getElementById('passcodeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!code) { setMessage('message', 'Please enter the passcode.', true); return; }

    const data = await api('/api/validate-passcode', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    localStorage.setItem('passcode_id', data.passcode_id);
    window.location.href = 'register.html';
  } catch (err) {
    setMessage('message', err.message, true);
  }
});

// ── CID validation form (register.html) ───────────────────────────────────────
// Step 2 of the participant flow. The participant enters their CID number, which
// must match a pre-registered participant record. On success the participant_id
// is stored in localStorage (used by the test page to identify the participant
// for submission), any previous timer is cleared, and the browser moves to the
// instructions page.
document.getElementById('cidForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // Verify the passcode gate was passed; send back to start if not.
    const passcodeId = localStorage.getItem('passcode_id');
    if (!passcodeId) { window.location.href = 'index.html'; return; }

    const cid = document.getElementById('cid_number').value.trim();
    if (!cid) { setMessage('message', 'Please enter your CID number.', true); return; }

    const data = await api('/api/validate-cid', {
      method: 'POST',
      body: JSON.stringify({ cid_number: cid, passcode_id: Number(passcodeId) }),
    });

    localStorage.setItem('participant_id', data.participant_id);
    // Clear any leftover timer from a previous session so the clock starts fresh
    // when the participant reaches the test page.
    localStorage.removeItem('test_start_time');
    window.location.href = 'instructions.html';
  } catch (err) {
    setMessage('message', err.message, true);
  }
});
