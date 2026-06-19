/* ============================================================
   common.js — Shared utilities loaded on every admin page.
   Depends on nothing; consumed by admin.js, auth.js, test.js.
   ============================================================ */

/**
 * Renders an inline success or error message inside the element with the given id.
 * The CSS classes "message success" / "message error" control the visual styling.
 */
function setMessage(id, text, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `message ${isError ? 'error' : 'success'}`;
}

/**
 * Escapes HTML special characters before injecting user-supplied data into innerHTML.
 * Without this, an attacker could inject <script> tags or event handlers (XSS).
 * Use textContent instead of innerHTML when possible; use this helper when you
 * need innerHTML for layout reasons (e.g. table cells with sub-elements).
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&',  '&amp;')
    .replaceAll('<',  '&lt;')
    .replaceAll('>',  '&gt;')
    .replaceAll('"',  '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * Converts common image-sharing links to a URL that works in an <img> tag.
 *
 * Google Drive share/view links point to a webpage, not image bytes.
 * We extract the file ID and route the request through our server-side
 * /api/image-proxy endpoint, which fetches the thumbnail from Google and
 * streams it back. This avoids CORS, rate-limit, and virus-scan redirect issues.
 */
function toDirectImageUrl(url) {
  if (!url) return url;

  let driveId = null;

  // https://drive.google.com/file/d/FILE_ID/view?...
  const m1 = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (m1) driveId = m1[1];

  // https://drive.google.com/open?id=FILE_ID
  if (!driveId) {
    const m2 = url.match(/drive\.google\.com\/open\?.*[?&]id=([^&]+)/);
    if (m2) driveId = m2[1];
  }

  // https://drive.google.com/uc?export=view&id=FILE_ID  (older manual format)
  if (!driveId) {
    const m3 = url.match(/drive\.google\.com\/uc\?.*[?&]id=([^&]+)/);
    if (m3) driveId = m3[1];
  }

  // https://drive.google.com/thumbnail?id=FILE_ID  (already thumbnail format)
  if (!driveId) {
    const m4 = url.match(/drive\.google\.com\/thumbnail\?.*[?&]id=([^&]+)/);
    if (m4) driveId = m4[1];
  }

  if (driveId) {
    const thumbnailUrl = `https://drive.google.com/thumbnail?id=${driveId}&sz=w1200`;
    return `/api/image-proxy?url=${encodeURIComponent(thumbnailUrl)}`;
  }

  return url;
}

/**
 * Converts a date string from the API into a human-readable local time string.
 * The backend stores timestamps in UTC and formats them as "YYYY-MM-DD HH:MM"
 * (no timezone marker). We normalise to ISO 8601 UTC before parsing so the
 * JavaScript Date constructor treats them as UTC rather than local time, then
 * convert to Asia/Thimphu (Bhutan Standard Time, UTC+6) for display.
 */
function formatDate(value) {
  if (!value) return '-';
  let str = String(value).trim();
  // Append 'Z' (UTC marker) so the browser does not assume local time.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(str)) {
    str = str.replace(' ', 'T') + ':00Z';
  }
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return value; // Return original if unparseable.
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Thimphu',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Lazily creates the shared modal DOM node and appends it to <body> once.
 * All modal helpers reuse the same element rather than creating a new one
 * each time, so there is never more than one modal in the DOM.
 */
function ensureAppModal() {
  let modal = document.getElementById('appModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id        = 'appModal';
  modal.className = 'app-modal hidden';
  modal.innerHTML = `
    <div class="app-modal-backdrop" data-modal-close="false"></div>
    <div class="app-modal-card" role="dialog" aria-modal="true" aria-labelledby="appModalTitle">
      <div class="app-modal-icon" id="appModalIcon">i</div>
      <h3 id="appModalTitle" class="app-modal-title">Message</h3>
      <div id="appModalBody" class="app-modal-body"></div>
      <div class="app-modal-actions">
        <button id="appModalCancel"  class="btn-outline" type="button">Cancel</button>
        <button id="appModalConfirm" class="btn"         type="button">OK</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

/**
 * Shows a promise-based modal dialog.
 * Resolves true when the user confirms (button click or Enter key).
 * Resolves false when the user cancels (Cancel button or Escape key).
 *
 * @param {Object}  opts
 * @param {string}  opts.title       - Modal heading text.
 * @param {string}  opts.message     - Body text (or HTML if allowHtml is true).
 * @param {string}  opts.type        - Icon style: 'info' | 'success' | 'error' | 'warning' | 'confirm'.
 * @param {string}  opts.confirmText - Label for the primary button.
 * @param {string}  opts.cancelText  - Label for the cancel button (hidden if empty).
 * @param {boolean} opts.allowHtml   - Set true to inject message as innerHTML (use carefully).
 */
function showModal({ title = 'Message', message = '', type = 'info', confirmText = 'OK', cancelText = '', allowHtml = false } = {}) {
  return new Promise((resolve) => {
    const modal      = ensureAppModal();
    const icon       = document.getElementById('appModalIcon');
    const titleEl    = document.getElementById('appModalTitle');
    const bodyEl     = document.getElementById('appModalBody');
    const confirmBtn = document.getElementById('appModalConfirm');
    const cancelBtn  = document.getElementById('appModalCancel');

    const iconMap = { success: '✓', error: '!', warning: '!', confirm: '?', info: 'i' };
    icon.className   = `app-modal-icon ${type}`;
    icon.textContent = iconMap[type] || 'i';
    titleEl.textContent = title;

    if (allowHtml) bodyEl.innerHTML = message;
    else           bodyEl.textContent = message;

    confirmBtn.textContent = confirmText || 'OK';
    cancelBtn.textContent  = cancelText  || 'Cancel';
    // Hide the cancel button for informational modals that only need an "OK".
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

    // Keyboard shortcuts: Enter confirms, Escape cancels.
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };
    document.addEventListener('keydown', onKey);

    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick  = () => cleanup(false);

    // Focus the confirm button after a short delay so the user can press Enter
    // immediately without needing to click.
    setTimeout(() => confirmBtn.focus(), 50);
  });
}

/** Shows an informational modal with only an "OK" button. */
function showInfo(message, title = 'Information') {
  return showModal({ title, message, type: 'info', confirmText: 'OK' });
}

/** Shows a success modal with only an "OK" button. */
function showSuccess(message, title = 'Success') {
  return showModal({ title, message, type: 'success', confirmText: 'OK' });
}

/** Shows an error modal with only an "OK" button. */
function showError(message, title = 'Error') {
  return showModal({ title, message, type: 'error', confirmText: 'OK' });
}

/** Shows a confirmation modal with "Cancel" and a custom primary button label. */
function showConfirm(message, title = 'Please Confirm', confirmText = 'Confirm') {
  return showModal({ title, message, type: 'confirm', confirmText, cancelText: 'Cancel' });
}

/**
 * Thin fetch wrapper used by all admin and participant pages.
 * - Automatically includes session cookies (credentials: 'include').
 * - Sets Content-Type: application/json by default (override via options.headers).
 * - Parses the JSON response body and throws a descriptive Error when the
 *   HTTP status is not in the 2xx range, using the server's "error" field if present.
 */
async function api(url, options = {}) {
  const res  = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url.startsWith('/api/admin/') && !window.location.pathname.endsWith('admin-login.html')) {
    window.location.href = 'admin-login.html';
    return;
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
