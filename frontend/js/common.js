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
let _modalActive = false;
let _modalQueue  = [];

// Only one #appModal exists in the DOM. Calling showModal again while one is
// already open would overwrite its button handlers and stack a second keydown
// listener, leaving the first caller's promise unresolved if the user clicks a
// button instead of pressing a key. Queue overlapping calls instead so each
// modal fully resolves before the next one takes over the shared element.
function showModal(opts = {}) {
  return new Promise((resolve) => {
    const job = () => runModal(opts, resolve);
    if (_modalActive) _modalQueue.push(job);
    else { _modalActive = true; job(); }
  });
}

function runModal({ title = 'Message', message = '', type = 'info', confirmText = 'OK', cancelText = '', allowHtml = false }, resolve) {
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
    const next = _modalQueue.shift();
    if (next) next();
    else _modalActive = false;
  };

  // Keyboard shortcuts: Enter confirms, Escape cancels. Enter while the Cancel
  // button has focus must cancel, not confirm, or a keyboard user who tabbed
  // to Cancel would trigger the destructive action.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    else if (e.key === 'Enter') { e.preventDefault(); cleanup(document.activeElement !== cancelBtn); }
    else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const items = [cancelBtn, confirmBtn].filter(b => !b.classList.contains('hidden'));
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length]?.focus();
    }
  };
  document.addEventListener('keydown', onKey);

  confirmBtn.onclick = () => cleanup(true);
  cancelBtn.onclick  = () => cleanup(false);
  // Clicking outside a confirmation dialog cancels it (informational ones
  // with only "OK" still require the button so they are not missed).
  modal.querySelector('.app-modal-backdrop').onclick = cancelText ? () => cleanup(false) : null;

  // Focus the confirm button after a short delay so the user can press Enter
  // immediately without needing to click.
  setTimeout(() => confirmBtn.focus(), 50);
}

/** Shows an informational modal with only an "OK" button. */
function showInfo(message, title = 'Information') {
  return showModal({ title, message, type: 'info', confirmText: 'OK' });
}

/**
 * Shows a success notification as a non-blocking toast. Routine confirmations
 * ("Saved", "Deleted", "Copied") no longer interrupt the admin with a modal
 * they must click away. Returns a resolved promise so existing
 * `await showSuccess(...)` callers continue immediately.
 */
function showSuccess(message, title = 'Success') {
  showToast(message, 'success', title);
  return Promise.resolve(true);
}

/* ── Toast notifications ──────────────────────────────────────────────────── */

function ensureToastHost() {
  let host = document.getElementById('toastHost');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'toastHost';
  host.className = 'toast-host';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * Shows a small notification in the corner that disappears on its own.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {string} title     Optional bold heading.
 * @param {number} duration  Milliseconds before auto-dismiss (0 = sticky).
 */
function showToast(message, type = 'info', title = '', duration = 3500) {
  const host  = ensureToastHost();
  const icons = { success: '✓', error: '!', warning: '!', info: 'i' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || 'i'}</span>
    <div class="toast-body">
      ${title ? `<p class="toast-title">${escapeHtml(title)}</p>` : ''}
      <p class="toast-msg">${escapeHtml(message)}</p>
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>`;

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add('toast-leave');
    setTimeout(() => toast.remove(), 200);
  };
  const arm = () => { if (duration > 0) timer = setTimeout(dismiss, duration); };
  toast.querySelector('.toast-close').onclick = dismiss;
  // Pause the countdown while the pointer is over the toast so it can be read.
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', arm);

  host.appendChild(toast);
  // Keep at most 4 toasts on screen.
  while (host.children.length > 4) host.firstElementChild.remove();
  arm();
  return dismiss;
}

/* ── Button busy state ────────────────────────────────────────────────────── */

/**
 * Puts a button into a loading state (spinner + disabled) while `task` runs,
 * preventing double submissions and showing the user that something is
 * happening. Restores the original content afterwards, even on error.
 */
async function withBusy(button, task, busyLabel = 'Please wait…') {
  if (!button) return task();
  let keep = false;
  if (button.dataset.busy === '1') return;
  const original = button.innerHTML;
  const wasDisabled = button.disabled;
  button.dataset.busy = '1';
  button._idleState = { html: original, disabled: wasDisabled };
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${escapeHtml(busyLabel)}</span>`;
  try {
    const result = await task();
    // A task that is navigating to another page returns withBusy.KEEP so the
    // spinner stays up instead of flicking back to the idle label.
    keep = result === withBusy.KEEP;
    return result;
  } finally {
    // The page may have navigated away / replaced the button; guard access.
    if (button.isConnected && !keep) {
      button.innerHTML = original;
      button.disabled = wasDisabled;
      button.removeAttribute('aria-busy');
    }
    if (!keep) delete button.dataset.busy;
  }
}
withBusy.KEEP = Symbol('keep-busy');

// Pages restored from the back/forward cache keep their last DOM, so a button
// left busy by a navigating task would still be spinning. Reset those.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  document.querySelectorAll('button[data-busy="1"]').forEach(btn => {
    if (btn._idleState) { btn.innerHTML = btn._idleState.html; btn.disabled = btn._idleState.disabled; }
    btn.removeAttribute('aria-busy');
    delete btn.dataset.busy;
  });
});

/* ── Connection status ────────────────────────────────────────────────────── */
// Tell the user straight away when their connection drops or comes back,
// instead of letting the next action fail with a generic error.
window.addEventListener('offline', () =>
  showToast('You are offline. Changes will fail until the connection returns.', 'warning', 'Connection lost', 6000));
window.addEventListener('online', () =>
  showToast('Your connection has been restored.', 'success', 'Back online'));

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
/**
 * Renders question text as HTML, converting any pipe-delimited markdown tables
 * into real <table> elements so admins and participants can read structured data.
 * All cell and paragraph content is HTML-escaped before insertion.
 */
function renderQuestionText(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].includes('|')) {
      // Collect every consecutive line that contains a pipe.
      const tableLines = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      // Parse each row: strip outer pipes, split on '|', trim cells.
      const rows = tableLines.map(l =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
      );
      // Identify the separator row (cells made of dashes/colons only).
      const isSep  = r => r.length > 0 && r.every(c => /^[-:\s]+$/.test(c));
      const sepIdx = rows.findIndex(isSep);

      const headerRows = sepIdx > 0  ? rows.slice(0, sepIdx)    : [];
      const dataRows   = sepIdx >= 0 ? rows.slice(sepIdx + 1)   : rows;

      let html = '<table class="q-table">';
      if (headerRows.length) {
        html += '<thead>' + headerRows.map(r =>
          '<tr>' + r.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>'
        ).join('') + '</thead>';
      }
      if (dataRows.length) {
        html += '<tbody>' + dataRows.map(r =>
          '<tr>' + r.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>'
        ).join('') + '</tbody>';
      }
      html += '</table>';
      parts.push(`<div class="q-table-scroll">${html}</div>`);
    } else {
      const trimmed = lines[i].trim();
      if (trimmed) parts.push(`<p class="q-text-para">${escapeHtml(trimmed)}</p>`);
      i++;
    }
  }
  return parts.join('');
}

// participantAuthHeader returns the participant session token header for
// participant API calls (issued by /api/validate-cid). Admin calls use the
// admin_session cookie instead, so they never carry it.
function participantAuthHeader(url) {
  const token = localStorage.getItem('participant_token');
  return token && !url.startsWith('/api/admin/') ? { 'X-Participant-Token': token } : {};
}

// Requests that get no response within this time are abandoned, so buttons
// showing a spinner never hang indefinitely on a stalled connection.
const API_TIMEOUT_MS = 30000;

async function api(url, options = {}) {
  const { timeout = API_TIMEOUT_MS, headers: extraHeaders, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      ...rest,
      // X-Requested-With can only be set by same-origin script (a plain cross-site
      // <form> CSRF submission cannot add it), so the server uses its presence as
      // a defense-in-depth CSRF check on top of the SameSite=Lax session cookie.
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DAES', ...participantAuthHeader(url), ...(extraHeaders || {}) },
    });
  } catch (err) {
    // A timeout is reported as a TypeError, the same as being offline, so
    // callers that retry on connection loss (test autosave and submission)
    // also retry after a timeout.
    if (err?.name === 'AbortError') throw new TypeError('The server took too long to respond. Please try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url.startsWith('/api/admin/') && !window.location.pathname.endsWith('admin-login.html')) {
    window.location.href = 'admin-login.html';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    // Keep the HTTP status and the response body (e.g. an error "code") so
    // callers can react to specific failures, not just show the message.
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}
