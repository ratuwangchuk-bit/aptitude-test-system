/* ============================================================
   common.js — Shared utilities loaded on every admin page
   ============================================================ */

/** Renders an inline success or error message inside a named element. */
function setMessage(id, text, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `message ${isError ? 'error' : 'success'}`;
}

/** Escapes HTML special characters to prevent XSS when injecting user data into innerHTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Converts an ISO date string to a locale-formatted date/time string. */
function formatDate(value) {
  if (!value) return '-';
  let str = String(value).trim();
  // Backend sends plain UTC strings like "2026-05-22 16:05" with no timezone marker.
  // Normalize to ISO 8601 UTC so JavaScript parses them correctly.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(str)) {
    str = str.replace(' ', 'T') + ':00Z';
  }
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Thimphu',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Lazily creates the shared modal DOM node and appends it to <body> once. */
function ensureAppModal() {
  let modal = document.getElementById('appModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'appModal';
  modal.className = 'app-modal hidden';
  modal.innerHTML = `
    <div class="app-modal-backdrop" data-modal-close="false"></div>
    <div class="app-modal-card" role="dialog" aria-modal="true" aria-labelledby="appModalTitle">
      <div class="app-modal-icon" id="appModalIcon">i</div>
      <h3 id="appModalTitle" class="app-modal-title">Message</h3>
      <div id="appModalBody" class="app-modal-body"></div>
      <div class="app-modal-actions">
        <button id="appModalCancel" class="btn-outline" type="button">Cancel</button>
        <button id="appModalConfirm" class="btn" type="button">OK</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

/**
 * Shows a promise-based modal dialog.
 * Resolves true when the user confirms, false when they cancel or press Escape.
 */
function showModal({ title = 'Message', message = '', type = 'info', confirmText = 'OK', cancelText = '', allowHtml = false } = {}) {
  return new Promise((resolve) => {
    const modal = ensureAppModal();
    const icon      = document.getElementById('appModalIcon');
    const titleEl   = document.getElementById('appModalTitle');
    const bodyEl    = document.getElementById('appModalBody');
    const confirmBtn = document.getElementById('appModalConfirm');
    const cancelBtn  = document.getElementById('appModalCancel');

    const iconMap = { success: '✓', error: '!', warning: '!', confirm: '?', info: 'i' };
    icon.className   = `app-modal-icon ${type}`;
    icon.textContent = iconMap[type] || 'i';
    titleEl.textContent = title;

    if (allowHtml) bodyEl.innerHTML = message;
    else bodyEl.textContent = message;

    confirmBtn.textContent = confirmText || 'OK';
    cancelBtn.textContent  = cancelText  || 'Cancel';
    cancelBtn.classList.toggle('hidden', !cancelText);

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const cleanup = (result) => {
      modal.classList.add('hidden');
      document.body.classList.remove('modal-open');
      confirmBtn.onclick = null;
      cancelBtn.onclick  = null;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    /* Keyboard: Enter = confirm, Escape = cancel */
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };
    document.addEventListener('keydown', onKey);

    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick  = () => cleanup(false);
    setTimeout(() => confirmBtn.focus(), 50);
  });
}

/** Shows an informational modal (no cancel button). */
function showInfo(message, title = 'Information') {
  return showModal({ title, message, type: 'info', confirmText: 'OK' });
}

/** Shows a success modal (no cancel button). */
function showSuccess(message, title = 'Success') {
  return showModal({ title, message, type: 'success', confirmText: 'OK' });
}

/** Shows an error modal (no cancel button). */
function showError(message, title = 'Error') {
  return showModal({ title, message, type: 'error', confirmText: 'OK' });
}

/** Shows a confirmation modal with Cancel and a custom confirm label. */
function showConfirm(message, title = 'Please Confirm', confirmText = 'Confirm') {
  return showModal({ title, message, type: 'confirm', confirmText, cancelText: 'Cancel' });
}

/**
 * Thin fetch wrapper that:
 *  - sends credentials (session cookies)
 *  - sets JSON content-type by default
 *  - throws a descriptive Error when the response is not OK
 */
async function api(url, options = {}) {
  const res  = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
