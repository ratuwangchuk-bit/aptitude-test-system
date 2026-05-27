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

document.getElementById('cidForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const passcodeId = localStorage.getItem('passcode_id');
    if (!passcodeId) { window.location.href = 'index.html'; return; }
    const cid = document.getElementById('cid_number').value.trim();
    if (!cid) { setMessage('message', 'Please enter your CID number.', true); return; }
    const data = await api('/api/validate-cid', {
      method: 'POST',
      body: JSON.stringify({ cid_number: cid }),
    });
    localStorage.setItem('participant_id', data.participant_id);
    localStorage.removeItem('test_start_time');
    window.location.href = 'instructions.html';
  } catch (err) {
    setMessage('message', err.message, true);
  }
});
