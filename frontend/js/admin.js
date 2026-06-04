/* ============================================================
   admin.js  —  All admin panel logic
   Loaded on every admin page. Depends on common.js (api,
   escapeHtml, formatDate, showModal helpers).
   ============================================================ */

/* ── Module state ──────────────────────────────────────────── */
let allResults          = [];
let allQuestions        = [];
let allAnswers          = [];
let allPasscodes        = [];
let allParticipants     = [];
let currentAdmin        = { id: 0, role: '', username: '' };
let dashboardTimer      = null;

// Tracks which rows the super-admin has checked for bulk delete.
let selectedResultIds      = new Set();
let selectedParticipantIds = new Set();
let selectedQuestionIds    = new Set();
let selectedAnswerIds      = new Set();
let currentResultDetail    = null;

/* ── Icon SVGs ─────────────────────────────────────────────── */
// Defined first so every render function below can reference them safely.
const ICON = {
  copy:   `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  trash:  `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  edit:   `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  key:    `<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>`,
  lock:   `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
  eye:      `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  download: `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  shield:   `<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

// Short labels used inside section pills in tables.
const SECTION_SHORT = {
  'Analytical Ability':  'Analytical',
  'Verbal Ability':      'Verbal',
  'Quantitative Skills': 'Quantitative',
};

/* ── Auth ──────────────────────────────────────────────────── */

function isSuperAdmin() {
  return currentAdmin.role === 'super_admin';
}

// Loads the current admin's profile from the server and applies role-based UI.
// Redirects to the login page if the session is missing or expired.
async function loadCurrentAdmin() {
  // Skip on the login page — no session exists there yet.
  if (!document.body.classList.contains('admin-body') || document.getElementById('adminLoginForm')) return;
  try {
    currentAdmin = await api('/api/admin/me');
    applyRoleUI();
  } catch {
    window.location.href = 'admin-login.html';
  }
}

// Hides super-admin-only elements for general admins.
// Also redirects general admins away from restricted pages.
function applyRoleUI() {
  const isSuper = isSuperAdmin();
  document.querySelectorAll('.super-only').forEach(el => el.classList.toggle('hidden', !isSuper));
  if (!isSuper) {
    document.querySelectorAll('.management-panel').forEach(el => el.classList.add('hidden'));
  }
  // Guard restricted pages: redirect general admins back to the dashboard.
  const page = location.pathname.split('/').pop();
  if (!isSuper && (page === 'passcodes.html' || page === 'admins.html')) {
    showError('Only super admins can access this page.', 'Access Restricted')
      .then(() => window.location.href = 'admin-dashboard.html');
  }
}

// Login form submit handler.
document.getElementById('adminLoginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    window.location.href = 'admin-dashboard.html';
  } catch (err) {
    showError(err.message, 'Login Failed');
  }
});

// Confirms, calls logout endpoint, then sends the user to the login page.
async function logout() {
  const ok = await showConfirm('Do you want to securely exit the admin panel?', 'Logout', 'Logout');
  if (!ok) return;
  try { await api('/api/admin/logout', { method: 'POST' }); } finally {
    window.location.href = 'admin-login.html';
  }
}

/* ── Dashboard ─────────────────────────────────────────────── */

// Fetches summary stats + results, then renders metric cards and charts.
// Pass showErrors=false when called by the auto-refresh timer so silent
// failures don't pop up a redirect modal in the background.
async function loadDashboard(showErrors = true) {
  if (!document.getElementById('summary')) return;
  try {
    const s          = await api('/api/admin/dashboard');
    const appeared   = s.appeared_participants || 0;
    const registered = s.total_participants    || 0;
    const turnout    = registered ? Math.round((appeared / registered) * 100) : 0;

    document.getElementById('summary').innerHTML = `
      <div class="card metric-card card-hover">
        <span class="metric-icon blue"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
        <p class="metric-label">Registered</p><p class="metric-value">${registered}</p><p class="metric-note">Total registered</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon teal"><svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></span>
        <p class="metric-label">Appeared</p><p class="metric-value">${appeared}</p><p class="metric-note">Turnout ${turnout}%</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon amber"><svg viewBox="0 0 24 24"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg></span>
        <p class="metric-label">Highest Score</p><p class="metric-value">${s.highest_score || 0}<small>/45</small></p><p class="metric-note">Top performer</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon purple"><svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span>
        <p class="metric-label">Average Score</p><p class="metric-value">${Number(s.average_score || 0).toFixed(1)}<small>/45</small></p><p class="metric-note">Overall average</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon rose"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></span>
        <p class="metric-label">Lowest Score</p><p class="metric-value">${s.lowest_score || 0}<small>/45</small></p><p class="metric-note">Minimum score</p>
      </div>`;

    allResults = await api('/api/admin/results');
    renderResults(filterResults(allResults));
    renderCharts(allResults, appeared, registered);
  } catch (err) {
    if (showErrors) {
      showError('Session expired or dashboard failed to load.', 'Dashboard Error')
        .then(() => window.location.href = 'admin-login.html');
    }
  }
}

// Filters allResults by the text in the search box.
function filterResults(rows) {
  const term = (document.getElementById('resultSearch')?.value || '').toLowerCase();
  if (!term) return rows;
  return rows.filter(r =>
    `${r.full_name} ${r.cid_number} ${r.company_name} ${r.contact_number}`.toLowerCase().includes(term)
  );
}

document.getElementById('resultSearch')?.addEventListener('input', () => renderResults(filterResults(allResults)));

// Starts the 15-second silent auto-refresh for the dashboard summary and table.
function startDashboardAutoRefresh() {
  if (!document.getElementById('summary')) return;
  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = setInterval(() => loadDashboard(false), 15000);
}

/* ── Charts ────────────────────────────────────────────────── */

function renderCharts(rows, appeared, total) {
  renderSectionChart(rows || []);
  renderDistributionChart(rows || []);
  renderTurnoutChart(appeared || 0, total || 0);
}

// Renders a horizontal bar chart showing average scores per section.
function renderSectionChart(rows) {
  const el = document.getElementById('sectionChart');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="empty-chart">No results yet. Charts appear after participants submit the test.</div>`;
    return;
  }
  const n = rows.length;
  const sections = [
    { label: 'Analytical Ability',  key: 'analytical_score',   cls: 'analytical'   },
    { label: 'Verbal Ability',      key: 'verbal_score',        cls: 'verbal'        },
    { label: 'Quantitative Skills', key: 'quantitative_score',  cls: 'quantitative'  },
  ];
  el.innerHTML = sections.map(({ label, key, cls }) => {
    const avg     = rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / n;
    const percent = Math.min(100, (avg / 15) * 100);
    return `
      <div class="chart-row">
        <div class="chart-row-head"><span>${label}</span><b>${avg.toFixed(1)}/15</b></div>
        <div class="bar-track"><span class="bar-fill ${cls}" style="width:${percent}%"></span></div>
      </div>`;
  }).join('');
}

// Renders an SVG donut ring showing participated vs registered ratio.
function renderTurnoutChart(appeared, total) {
  const el = document.getElementById('turnoutChart');
  if (!el) return;
  if (!total) {
    el.innerHTML = `<div class="empty-chart">No participants registered yet.</div>`;
    return;
  }
  const pct     = Math.round((appeared / total) * 100);
  const pending = Math.max(0, total - appeared);
  const r       = 40;
  const circ    = 2 * Math.PI * r;
  const dash    = ((pct / 100) * circ).toFixed(1);
  el.innerHTML = `
    <div class="turnout-wrap">
      <svg viewBox="0 0 120 120" class="turnout-donut" role="img" aria-label="Turnout ${pct}%">
        <defs>
          <linearGradient id="tGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2563eb"/>
            <stop offset="100%" stop-color="#14b8a6"/>
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="${r}" class="donut-track"/>
        <circle cx="60" cy="60" r="${r}" class="donut-fill"
          stroke-dasharray="${dash} ${circ.toFixed(1)}"
          transform="rotate(-90 60 60)"/>
        <text x="60" y="54" class="donut-pct">${pct}%</text>
        <text x="60" y="73" class="donut-sub">turnout</text>
      </svg>
      <div class="turnout-legend">
        <div class="tleg-row"><span class="tleg-dot appeared"></span><span class="tleg-label">Appeared</span><b>${appeared}</b></div>
        <div class="tleg-row"><span class="tleg-dot" style="background:#fbbf24"></span><span class="tleg-label">Pending</span><b>${pending}</b></div>
        <div class="tleg-row"><span class="tleg-dot pending"></span><span class="tleg-label">Registered</span><b>${total}</b></div>
      </div>
    </div>`;
}

// Renders a mini bar chart bucketing scores into five ranges.
function renderDistributionChart(rows) {
  const el = document.getElementById('distributionChart');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="empty-chart">No score distribution yet.</div>`;
    return;
  }
  const buckets = [
    { label: '0–9',   min: 0,  max: 9  },
    { label: '10–18', min: 10, max: 18 },
    { label: '19–27', min: 19, max: 27 },
    { label: '28–36', min: 28, max: 36 },
    { label: '37–45', min: 37, max: 45 },
  ].map(b => ({ ...b, count: rows.filter(r => Number(r.score || 0) >= b.min && Number(r.score || 0) <= b.max).length }));
  const max = Math.max(1, ...buckets.map(b => b.count));
  el.innerHTML = buckets.map(b => `
    <div class="dist-row">
      <span>${b.label}</span>
      <div class="dist-track"><i style="width:${(b.count / max) * 100}%"></i></div>
      <b>${b.count}</b>
    </div>`).join('');
}

/* ── Results table ─────────────────────────────────────────── */

// Renders result rows. All admins see a View button; super admins also see checkbox and Delete.
function renderResults(rows) {
  const tbody = document.getElementById('results');
  if (!tbody) return;
  // Reset the header checkbox whenever the table re-renders.
  const selectAll = document.getElementById('selectAllResults');
  if (selectAll) selectAll.checked = false;
  const extra = isSuperAdmin() ? 2 : 0; // checkbox col + action col
  tbody.innerHTML = rows.length
    ? rows.map((r, i) => `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="result-checkbox" data-id="${r.submission_id}" ${selectedResultIds.has(r.submission_id) ? 'checked' : ''} onchange="toggleResultSelection(${r.submission_id}, this)"></td>` : ''}
          <td class="text-center"><span class="serial-badge">${i + 1}</span></td>
          <td><b>${escapeHtml(r.full_name)}</b><div class="text-xs text-slate-500 mt-1">CID: ${escapeHtml(r.cid_number || '-')}</div></td>
          <td><span class="score-badge total">${r.score}/${r.total_questions || 45}</span></td>
          <td><span class="score-badge analytical">${r.analytical_score}/15</span></td>
          <td><span class="score-badge verbal">${r.verbal_score}/15</span></td>
          <td><span class="score-badge quantitative">${r.quantitative_score}/15</span></td>
          <td><span class="rank-badge">${r.rank}</span></td>
          <td>${escapeHtml(r.company_name || '-')}</td>
          <td>${escapeHtml(r.contact_number || '-')}</td>
          <td><button class="btn-icon btn-soft" title="View answer sheet" onclick="viewParticipantResult(${r.submission_id})">${ICON.eye}</button></td>
          ${isSuperAdmin() ? `<td><button class="btn-icon btn-danger" title="Delete" onclick="deleteResult(${r.submission_id})">${ICON.trash}</button></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${10 + extra}" class="text-center text-slate-500 py-8">No results yet.</td></tr>`;
}

function toggleResultSelection(id, el) {
  if (el.checked) selectedResultIds.add(id);
  else selectedResultIds.delete(id);
  syncResultsDeleteBtn();
}

function toggleSelectAllResults(el) {
  document.querySelectorAll('.result-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedResultIds.add(id);
    else selectedResultIds.delete(id);
  });
  syncResultsDeleteBtn();
}

// Shows/hides the "Delete Selected" button and keeps its count label current.
function syncResultsDeleteBtn() {
  const btn = document.getElementById('deleteSelectedResultsBtn');
  if (!btn || !isSuperAdmin()) return;
  const show = selectedResultIds.size > 0;
  btn.classList.toggle('hidden', !show);
  if (show) btn.querySelector('span').textContent = `Delete Selected (${selectedResultIds.size})`;
}

async function deleteResult(id) {
  const ok = await showConfirm('Delete this result? The participant will be able to retake the test.', 'Delete Result', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/results/${id}`, { method: 'DELETE' });
    selectedResultIds.delete(id);
    syncResultsDeleteBtn();
    await showSuccess('Result deleted.', 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadDashboard(false); // reload regardless so the table stays in sync
}

async function deleteSelectedResults() {
  if (!selectedResultIds.size) return;
  const count = selectedResultIds.size;
  const ok = await showConfirm(
    `Delete ${count} result(s)? Those participants will be able to retake the test.`,
    'Delete Selected', 'Delete'
  );
  if (!ok) return;
  try {
    await Promise.all([...selectedResultIds].map(id => api(`/api/admin/results/${id}`, { method: 'DELETE' })));
    selectedResultIds.clear();
    syncResultsDeleteBtn();
    await showSuccess(`${count} result(s) deleted.`, 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadDashboard(false); // reload regardless of partial failures
}

/* ── Result detail modal ───────────────────────────────────── */

async function viewParticipantResult(submissionId) {
  try {
    const data = await api(`/api/admin/results/${submissionId}/detail`);
    showResultDetailModal(data);
  } catch (err) {
    showError(err.message, 'Could Not Load Result');
  }
}

function showResultDetailModal(d) {
  currentResultDetail = d;
  document.getElementById('resultDetailOverlay')?.remove();

  const opts = (a) => ({ A: a.option_a, B: a.option_b, C: a.option_c, D: a.option_d });
  const answersHtml = (d.answers || []).map((a, i) => {
    const o   = opts(a);
    const sel = a.selected_option || '';
    const selText  = sel && o[sel]           ? `${sel}. ${escapeHtml(o[sel])}`           : (sel || '—');
    const corrText = a.correct_option && o[a.correct_option] ? `${a.correct_option}. ${escapeHtml(o[a.correct_option])}` : (a.correct_option || '—');
    const rowCls   = a.is_correct ? 'rd-row-correct' : (sel ? 'rd-row-wrong' : '');
    const statusBadge = a.is_correct
      ? `<span class="rd-status correct">✓</span>`
      : (sel ? `<span class="rd-status wrong">✗</span>` : `<span class="rd-status skip">—</span>`);
    return `
      <tr class="${rowCls}">
        <td class="rd-qnum">${i + 1}</td>
        <td><span class="pill pill-teal" style="font-size:.72rem;padding:.28rem .55rem">${escapeHtml(SECTION_SHORT[a.section] || a.section || '-')}</span></td>
        <td class="rd-qtext">${escapeHtml(a.question_text)}</td>
        <td class="rd-ans ${a.is_correct ? 'correct' : (sel ? 'wrong' : '')}">${selText}</td>
        <td class="rd-ans correct">${corrText}</td>
        <td class="text-center">${statusBadge}</td>
      </tr>`;
  }).join('');

  const noAnswers = !d.answers || d.answers.length === 0
    ? `<tr><td colspan="6" class="text-center text-slate-500 py-8">No per-question data available for this submission.</td></tr>`
    : answersHtml;

  const pct = Number(d.percentage || 0).toFixed(1);

  const overlay = document.createElement('div');
  overlay.id = 'resultDetailOverlay';
  overlay.className = 'rd-overlay';
  overlay.innerHTML = `
    <div class="rd-backdrop" onclick="closeResultDetail()"></div>
    <div class="rd-panel">
      <div class="rd-header">
        <div>
          <h2 class="rd-name">${escapeHtml(d.full_name)}</h2>
          <p class="rd-sub">CID: ${escapeHtml(d.cid_number || '—')} &nbsp;·&nbsp; ${escapeHtml(d.company_name || '—')} &nbsp;·&nbsp; ${escapeHtml(d.contact_number || '—')}</p>
        </div>
        <button class="rd-close" onclick="closeResultDetail()" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="rd-scores">
        <div class="rd-score-item total"><span>Total</span><b>${d.score}/${d.total_questions || 45}</b></div>
        <div class="rd-score-item analytical"><span>Analytical</span><b>${d.analytical_score}/15</b></div>
        <div class="rd-score-item verbal"><span>Verbal</span><b>${d.verbal_score}/15</b></div>
        <div class="rd-score-item quantitative"><span>Quantitative</span><b>${d.quantitative_score}/15</b></div>
        <div class="rd-score-item pct"><span>Score %</span><b>${pct}%</b></div>
        <div class="rd-score-item rank"><span>Rank</span><b>#${d.rank}</b></div>
      </div>
      <div class="rd-table-wrap">
        <table class="rd-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Section</th>
              <th>Question</th>
              <th>Your Answer</th>
              <th>Correct Answer</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>${noAnswers}</tbody>
        </table>
      </div>
      <div class="rd-footer">
        <span>Submitted: ${d.submitted_at ? formatDate(d.submitted_at) : '—'}</span>
        <div style="display:flex;gap:.6rem;align-items:center">
          <button class="btn-icon btn-soft" title="Download result" onclick="downloadIndividualResult()">${ICON.download}</button>
          <button class="btn-outline" onclick="closeResultDetail()">Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');

  // Close on Escape key
  const onKey = (e) => { if (e.key === 'Escape') { closeResultDetail(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function closeResultDetail() {
  document.getElementById('resultDetailOverlay')?.remove();
  document.body.classList.remove('modal-open');
}

function downloadIndividualResult() {
  const d = currentResultDetail;
  if (!d) return;

  const opts = (a) => ({ A: a.option_a, B: a.option_b, C: a.option_c, D: a.option_d });
  const rows = (d.answers || []).map((a, i) => {
    const o        = opts(a);
    const sel      = a.selected_option || '';
    const selText  = sel && o[sel]              ? `${sel}. ${o[sel]}`              : (sel || '—');
    const corrText = a.correct_option && o[a.correct_option] ? `${a.correct_option}. ${o[a.correct_option]}` : (a.correct_option || '—');
    const rowCls   = a.is_correct ? 'correct-row' : (sel ? 'wrong-row' : '');
    const status   = a.is_correct ? '<span class="status-c">✓ Correct</span>' : (sel ? '<span class="status-w">✗ Wrong</span>' : '<span class="status-s">— Skipped</span>');
    const section  = SECTION_SHORT[a.section] || a.section;
    return `<tr class="${rowCls}">
      <td style="text-align:center;color:#94a3b8;font-weight:900">${i + 1}</td>
      <td>${section}</td>
      <td>${a.question_text}</td>
      <td class="${a.is_correct ? 'ans-c' : (sel ? 'ans-w' : '')}">${selText}</td>
      <td class="ans-c">${corrText}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  const pct = Number(d.percentage || 0).toFixed(1);
  const submittedAt = d.submitted_at ? formatDate(d.submitted_at) : '—';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <title>Result — ${d.full_name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Helvetica,Arial,sans-serif;color:#0f172a;padding:28px;font-size:13px}
    .header{border-bottom:2px solid #e2e8f0;padding-bottom:14px;margin-bottom:14px}
    .org{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#2563eb;margin-bottom:6px}
    .name{font-size:20px;font-weight:900}
    .sub{color:#64748b;font-size:11.5px;margin-top:5px}
    .scores{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding:12px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0}
    .si{text-align:center;min-width:82px}
    .si .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.055em;color:#64748b;display:block;margin-bottom:3px}
    .si .val{font-weight:900;font-size:16px}
    .si.total .val{color:#3730a3}.si.ana .val{color:#c2410c}.si.ver .val{color:#1d4ed8}.si.qnt .val{color:#166534}.si.pct .val{color:#0f766e}.si.rnk .val{color:#7c3aed}
    table{width:100%;border-collapse:collapse;font-size:11.5px}
    th{padding:7px 9px;text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.055em;color:#475569;background:#f8fafc;border-bottom:2px solid #e2e8f0;white-space:nowrap}
    td{padding:6px 9px;border-top:1px solid #f1f5f9;vertical-align:top}
    .correct-row{background:rgba(220,252,231,.45)}.wrong-row{background:rgba(254,226,226,.45)}
    .status-c{color:#16a34a;font-weight:900}.status-w{color:#dc2626;font-weight:900}.status-s{color:#94a3b8}
    .ans-c{color:#15803d;font-weight:700}.ans-w{color:#b91c1c;font-weight:700}
    .footer{margin-top:14px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;display:flex;justify-content:space-between}
    @media print{body{padding:0}}
  </style>
  </head><body>
  <div class="header">
    <div class="org">Digital Aptitude Evaluation System — Individual Result</div>
    <div class="name">${d.full_name}</div>
    <div class="sub">CID: ${d.cid_number || '—'} &nbsp;·&nbsp; ${d.company_name || '—'} &nbsp;·&nbsp; ${d.contact_number || '—'}</div>
  </div>
  <div class="scores">
    <div class="si total"><span class="lbl">Total Score</span><span class="val">${d.score}/${d.total_questions || 45}</span></div>
    <div class="si ana"><span class="lbl">Analytical</span><span class="val">${d.analytical_score}/15</span></div>
    <div class="si ver"><span class="lbl">Verbal</span><span class="val">${d.verbal_score}/15</span></div>
    <div class="si qnt"><span class="lbl">Quantitative</span><span class="val">${d.quantitative_score}/15</span></div>
    <div class="si pct"><span class="lbl">Score %</span><span class="val">${pct}%</span></div>
    <div class="si rnk"><span class="lbl">Rank</span><span class="val">#${d.rank}</span></div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Section</th><th>Question</th><th>Your Answer</th><th>Correct Answer</th><th>Result</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:16px;color:#64748b">No per-question data available.</td></tr>'}</tbody>
  </table>
  <div class="footer">
    <span>Submitted: ${submittedAt}</span>
    <span>DAES — Confidential</span>
  </div>
  <script>window.onload=()=>{window.print()}<\/script>
  </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

/* ── Print All Results ─────────────────────────────────────── */

function printAllResults() {
  const results = [...allResults].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  if (!results.length) { alert('No results to print.'); return; }

  const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const topScore  = results[0]?.score ?? '—';
  const avgScore  = results.length
    ? (results.reduce((s, r) => s + (r.score || 0), 0) / results.length).toFixed(1)
    : '—';

  const rows = results.map((r, i) => {
    const total = r.total_questions || 45;
    const pct   = ((r.score / total) * 100).toFixed(1);
    const pctN  = parseFloat(pct);
    const scoreCol = pctN >= 70 ? '#15803d' : pctN >= 50 ? '#1d4ed8' : '#b91c1c';
    return `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td class="c serial">${i + 1}</td>
      <td class="name-cell"><b>${escapeHtml(r.full_name)}</b><br><span class="cid">${escapeHtml(r.cid_number || '—')}</span></td>
      <td>${escapeHtml(r.company_name || '—')}</td>
      <td>${escapeHtml(r.contact_number || '—')}</td>
      <td class="c stotal" style="color:${scoreCol}">${r.score}/${total}</td>
      <td class="c">${r.analytical_score}/15</td>
      <td class="c">${r.verbal_score}/15</td>
      <td class="c">${r.quantitative_score}/15</td>
      <td class="c pct" style="color:${scoreCol}">${pct}%</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>HiPo Aptitude Test — All Results</title>
<style>
  @page {
    size: A4 landscape;
    margin: 32mm 12mm 24mm;
  }
  *  { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #0f172a; }

  /* ── Page header – fixed, repeats on every printed page ── */
  .pg-header {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 30mm;
    background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 58%, #0f766e 100%);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14mm;
    border-bottom: 3px solid #2dd4bf;
  }
  .pg-header .hl .org-name {
    font-size: 8.5px; font-weight: 800; text-transform: uppercase;
    letter-spacing: .14em; color: #2dd4bf; margin-bottom: 4px;
  }
  .pg-header .hl .test-title {
    font-size: 18px; font-weight: 900; color: #ffffff; line-height: 1;
  }
  .pg-header .hm {
    text-align: center; flex: 1; padding: 0 10mm;
  }
  .pg-header .hm .badge {
    display: inline-block; border: 1px solid rgba(255,255,255,.25);
    border-radius: 6px; padding: 5px 14px;
    font-size: 8.5px; font-weight: 800; text-transform: uppercase;
    letter-spacing: .1em; color: rgba(255,255,255,.7);
    background: rgba(255,255,255,.07);
  }
  .pg-header .hr { text-align: right; }
  .pg-header .hr .lbl {
    font-size: 8px; color: rgba(255,255,255,.45);
    text-transform: uppercase; letter-spacing: .09em; display: block; margin-bottom: 3px;
  }
  .pg-header .hr .val { font-size: 10.5px; color: rgba(255,255,255,.85); font-weight: 700; }

  /* ── Page footer – fixed, repeats on every printed page ── */
  .pg-footer {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 22mm;
    border-top: 1.5px solid #e2e8f0;
    background: #f8fafc;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14mm;
  }
  .pg-footer .fc { font-size: 8.5px; color: #475569; font-weight: 700; }
  .pg-footer .fr { font-size: 8px; color: #94a3b8; text-align: right; }

  /* ── Intro summary ── */
  .intro {
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 2px solid #e2e8f0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .intro-left .doc-title   { font-size: 14px; font-weight: 900; margin-bottom: 3px; }
  .intro-left .doc-sub     { font-size: 9.5px; color: #64748b; line-height: 1.5; }
  .intro-stats { display: flex; gap: 1px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .istat {
    text-align: center; padding: 8px 16px; background: #f8fafc; border-right: 1px solid #e2e8f0;
  }
  .istat:last-child { border-right: none; }
  .istat .lbl { font-size: 7.5px; text-transform: uppercase; letter-spacing: .07em; color: #94a3b8; display: block; margin-bottom: 3px; }
  .istat .val { font-size: 16px; font-weight: 900; color: #1e3a8a; }

  /* ── Result table ── */
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  thead { display: table-header-group; }
  thead tr { background: #1e3a8a; }
  th {
    padding: 7px 8px; text-align: left; font-size: 8px; font-weight: 800;
    text-transform: uppercase; letter-spacing: .07em; color: #fff;
    white-space: nowrap; border: none;
  }
  th.c { text-align: center; }
  .tbl-caption {
    background: #0f172a;
    padding: 8px 10px 7px;
    border-bottom: 2px solid #2dd4bf;
    text-align: left;
  }
  .tbl-caption-title {
    display: block;
    font-size: 10px; font-weight: 900; text-transform: none;
    letter-spacing: .01em; color: #ffffff; margin-bottom: 2px;
  }
  .tbl-caption-sub {
    display: block;
    font-size: 7.5px; font-weight: 600; text-transform: none;
    letter-spacing: .01em; color: rgba(255,255,255,.5);
  }
  td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tr.even td { background: #ffffff; }
  tr.odd  td { background: #f8fafc; }
  .c      { text-align: center; }
  .rank   { font-weight: 900; color: #7c3aed; font-size: 13px; }
  .serial { color: #94a3b8; font-weight: 700; }
  .name-cell b   { font-size: 11px; font-weight: 800; }
  .name-cell .cid { font-size: 8.5px; color: #94a3b8; }
  .stotal { font-weight: 900; font-size: 12px; }
  .pct    { font-weight: 800; }
</style>
</head>
<body>

  <!-- Repeating page header -->
  <div class="pg-header">
    <div class="hl">
      <div class="org-name">DHI Group of Company</div>
      <div class="test-title">HiPo Aptitude Test</div>
    </div>
    <div class="hm">
      <span class="badge">All Participants · Results Report</span>
    </div>
    <div class="hr">
      <span class="lbl">Date Printed</span>
      <span class="val">${printDate}</span>
    </div>
  </div>

  <!-- Repeating page footer -->
  <div class="pg-footer">
    <span class="fc">Confidential &mdash; For Internal Use Only &nbsp;&middot;&nbsp; DHI Group of Company</span>
    <span class="fr">HiPo Aptitude Test &nbsp;&middot;&nbsp; ${printDate}</span>
  </div>

  <!-- Intro summary block -->
  <div class="intro">
    <div class="intro-left">
      <div class="doc-title">Final Result Summary &mdash; All Participants</div>
      <div class="doc-sub">
        Sections: Analytical Ability &nbsp;&middot;&nbsp; Verbal Ability &nbsp;&middot;&nbsp; Quantitative Skills<br>
        45 Questions &nbsp;&middot;&nbsp; 1 Mark Per Question &nbsp;&middot;&nbsp; No Negative Marking &nbsp;&middot;&nbsp; Ranked by Total Score
      </div>
    </div>
    <div class="intro-stats">
      <div class="istat"><span class="lbl">Participants</span><span class="val">${results.length}</span></div>
      <div class="istat"><span class="lbl">Max Score</span><span class="val">45</span></div>
      <div class="istat"><span class="lbl">Top Score</span><span class="val">${topScore}</span></div>
      <div class="istat"><span class="lbl">Avg Score</span><span class="val">${avgScore}</span></div>
    </div>
  </div>

  <!-- Results table -->
  <table>
    <thead>
      <tr>
        <th colspan="9" class="tbl-caption">
          <span class="tbl-caption-title">Participant Results &mdash; Ranked by Total Score</span>
          <span class="tbl-caption-sub">45 Questions &nbsp;&middot;&nbsp; Sections: Analytical / Verbal / Quantitative &nbsp;&middot;&nbsp; 1 Mark Each &nbsp;&middot;&nbsp; No Negative Marking</span>
        </th>
      </tr>
      <tr>
        <th class="c">SL No.</th>
        <th>Name &amp; CID</th>
        <th>Company</th>
        <th>Contact</th>
        <th class="c">Total<br>/45</th>
        <th class="c">Analytical<br>/15</th>
        <th class="c">Verbal<br>/15</th>
        <th class="c">Quantitative<br>/15</th>
        <th class="c">Score %</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

/* ── Passcodes ─────────────────────────────────────────────── */

function renderPasscodes(rows) {
  const tbody = document.getElementById('passcodesTable');
  if (!tbody) return;
  tbody.innerHTML = rows.length
    ? rows.map(p => {
        const active = p.status?.toLowerCase() === 'active';
        return `
          <tr>
            <td><code class="passcode-code">${escapeHtml(p.code)}</code></td>
            <td>${formatDate(p.created_at)}</td>
            <td>${formatDate(p.expires_at)}</td>
            <td><span class="status-pill ${active ? 'active' : 'expired'}">${escapeHtml(p.status || '-')}</span></td>
            <td>
              <div class="flex gap-2">
                <button class="btn-icon btn-small" title="Copy" onclick="copyPasscode('${escapeHtml(p.code)}')">${ICON.copy}</button>
                <button class="btn-icon btn-danger" title="Delete" onclick="deletePasscode(${p.id})">${ICON.trash}</button>
              </div>
            </td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="text-center text-slate-500 py-8">No passcodes generated yet.</td></tr>`;
}

async function loadPasscodes() {
  if (!document.getElementById('passcodesTable')) return;
  try {
    allPasscodes = await api('/api/admin/passcodes');
    renderPasscodes(allPasscodes);
  } catch (err) {
    showError(err.message, 'Could Not Load Passcodes');
  }
}

async function generatePasscode() {
  try {
    const data    = await api('/api/admin/passcodes/generate', { method: 'POST' });
    const box     = document.getElementById('generatedPasscode');
    const helpBox = document.getElementById('passcodeHelpBox');
    if (helpBox) helpBox.classList.add('hidden');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = `
        <div class="generated-code-card">
          <span>New participant passcode</span>
          <code class="passcode-code">${escapeHtml(data.code)}</code>
          <button class="btn-small" onclick="copyPasscode('${escapeHtml(data.code)}')">Copy Code</button>
        </div>`;
    }
    await loadPasscodes();
    await showSuccess(`Passcode generated: ${data.code}. Expires in 1 hour 30 minutes.`, 'Generated');
  } catch (err) {
    showError(err.message, 'Generation Failed');
  }
}

async function deletePasscode(id) {
  const ok = await showConfirm('Delete this passcode permanently?', 'Delete Passcode', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/passcodes/${id}`, { method: 'DELETE' });
    await showSuccess('Passcode deleted.', 'Deleted');
    loadPasscodes();
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
}

async function copyPasscode(code) {
  try {
    await navigator.clipboard.writeText(code);
    await showSuccess(`Copied: ${code}`, 'Copied');
  } catch {
    // Clipboard API may be blocked (e.g. non-HTTPS) — show the code in a modal instead.
    showModal({
      title: 'Copy Manually',
      message: `Clipboard access denied. Copy this passcode manually:<br><br><code class="passcode-code">${escapeHtml(code)}</code>`,
      type: 'info', confirmText: 'Done', allowHtml: true,
    });
  }
}

/* ── Questions ─────────────────────────────────────────────── */

// Super admins see a checkbox column, Edit and Delete buttons; general admins see read-only.
function renderQuestions(rows) {
  const tbody = document.getElementById('questionsTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllQuestions');
  if (selectAll) selectAll.checked = false;

  // Update per-section bank counts in the summary cards.
  const countA = rows.filter(q => q.section === 'Analytical Ability').length;
  const countB = rows.filter(q => q.section === 'Verbal Ability').length;
  const countC = rows.filter(q => q.section === 'Quantitative Skills').length;
  const elA = document.getElementById('bankCountA');
  const elB = document.getElementById('bankCountB');
  const elC = document.getElementById('bankCountC');
  const warn = (el, count) => {
    if (!el) return;
    el.textContent = count;
    el.style.color = count < 15 ? '#dc2626' : '';
    el.title = count < 15 ? 'Warning: fewer than 15 questions — participants will see all of them' : '';
  };
  warn(elA, countA); warn(elB, countB); warn(elC, countC);
  tbody.innerHTML = rows.length
    ? rows.map(q => `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="question-checkbox" data-id="${q.id}" ${selectedQuestionIds.has(q.id) ? 'checked' : ''} onchange="toggleQuestionSelection(${q.id}, this)"></td>` : ''}
          <td><span class="pill">${q.id}</span></td>
          <td><span class="pill pill-teal">${escapeHtml(SECTION_SHORT[q.section] || q.section || '-')}</span></td>
          <td class="min-w-[260px]"><b>${escapeHtml(q.question_text)}</b></td>
          <td>${escapeHtml(q.option_a)}</td>
          <td>${escapeHtml(q.option_b)}</td>
          <td>${escapeHtml(q.option_c)}</td>
          <td>${escapeHtml(q.option_d)}</td>
          ${isSuperAdmin() ? `<td><div class="flex gap-2">
            <button class="btn-icon btn-warning" title="Edit"   onclick="editQuestion(${q.id})">${ICON.edit}</button>
            <button class="btn-icon btn-danger"  title="Delete" onclick="deleteQuestion(${q.id})">${ICON.trash}</button>
          </div></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${isSuperAdmin() ? 9 : 7}" class="text-center text-slate-500 py-8">No questions found.</td></tr>`;
}

function toggleQuestionSelection(id, el) {
  if (el.checked) selectedQuestionIds.add(id);
  else selectedQuestionIds.delete(id);
  syncQuestionsDeleteBtn();
}

function toggleSelectAllQuestions(el) {
  document.querySelectorAll('.question-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedQuestionIds.add(id);
    else selectedQuestionIds.delete(id);
  });
  syncQuestionsDeleteBtn();
}

function syncQuestionsDeleteBtn() {
  const btn = document.getElementById('deleteSelectedQuestionsBtn');
  if (!btn || !isSuperAdmin()) return;
  const show = selectedQuestionIds.size > 0;
  btn.classList.toggle('hidden', !show);
  if (show) btn.querySelector('span').textContent = `Delete Selected (${selectedQuestionIds.size})`;
}

async function deleteSelectedQuestions() {
  if (!selectedQuestionIds.size) return;
  const count = selectedQuestionIds.size;
  const ok = await showConfirm(
    `Delete ${count} question(s)? Their linked answers will also be removed.`,
    'Delete Selected', 'Delete'
  );
  if (!ok) return;
  try {
    await Promise.all([...selectedQuestionIds].map(id => api(`/api/admin/questions/${id}`, { method: 'DELETE' })));
    selectedQuestionIds.clear();
    syncQuestionsDeleteBtn();
    await showSuccess(`${count} question(s) deleted.`, 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadQuestionsAdmin();
}

async function loadQuestionsAdmin() {
  if (!document.getElementById('questionsTable')) return;
  try {
    allQuestions = (await api('/api/admin/questions')) || [];
    renderQuestions(allQuestions);
  } catch (err) {
    showError(err.message, 'Could Not Load Questions');
  }
}

document.getElementById('questionSearch')?.addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  renderQuestions(allQuestions.filter(q =>
    `${q.id} ${q.section} ${q.question_text} ${q.option_a} ${q.option_b} ${q.option_c} ${q.option_d}`.toLowerCase().includes(term)
  ));
});

// Fills the question form with an existing question's data for editing.
function editQuestion(id) {
  const q = allQuestions.find(q => Number(q.id) === Number(id));
  if (!q) return;
  document.getElementById('question_id_edit').value  = q.id;
  document.getElementById('question_section').value  = q.section || 'Analytical Ability';
  document.getElementById('question_text').value     = q.question_text;
  document.getElementById('option_a').value = q.option_a;
  document.getElementById('option_b').value = q.option_b;
  document.getElementById('option_c').value = q.option_c;
  document.getElementById('option_d').value = q.option_d;
  document.getElementById('questionFormTitle').textContent = `Edit Question #${q.id}`;
  document.getElementById('questionSubmitBtn').querySelector('span').textContent = 'Update Question';
  document.getElementById('cancelQuestionEdit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetQuestionForm() {
  document.getElementById('questionForm')?.reset();
  document.getElementById('question_id_edit').value = '';
  document.getElementById('question_section').value = 'Analytical Ability';
  document.getElementById('questionFormTitle').textContent = 'Add Question';
  document.getElementById('questionSubmitBtn').querySelector('span').textContent = 'Save Question';
  document.getElementById('cancelQuestionEdit').classList.add('hidden');
}

// Handles both create (no ID) and update (ID present) in a single submit handler.
document.getElementById('questionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id      = document.getElementById('question_id_edit').value;
  const payload = {
    section:       document.getElementById('question_section').value,
    question_text: document.getElementById('question_text').value,
    option_a:      document.getElementById('option_a').value,
    option_b:      document.getElementById('option_b').value,
    option_c:      document.getElementById('option_c').value,
    option_d:      document.getElementById('option_d').value,
  };
  try {
    await api(id ? `/api/admin/questions/${id}` : '/api/admin/questions', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    await showSuccess(id ? 'Question updated.' : 'Question saved.', 'Saved');
    resetQuestionForm();
    loadQuestionsAdmin();
  } catch (err) {
    showError(err.message, 'Save Failed');
  }
});

async function deleteQuestion(id) {
  const ok = await showConfirm('Delete this question? Its linked answer will also be removed.', 'Delete Question', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/questions/${id}`, { method: 'DELETE' });
    selectedQuestionIds.delete(id);
    syncQuestionsDeleteBtn();
    await showSuccess('Question deleted.', 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadQuestionsAdmin();
}

async function uploadQuestions() {
  const file = document.getElementById('questionFile')?.files[0];
  if (!file) return showError('Please choose an Excel file first.', 'File Required');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res  = await fetch('/api/admin/questions/upload', { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
    await showSuccess(`${data.questions || 0} questions and ${data.answers || 0} answers uploaded.`, 'Upload Complete');
    loadQuestionsAdmin();
  } catch (err) {
    showError(err.message, 'Upload Failed');
  }
}

/* ── Answers ───────────────────────────────────────────────── */

// Super admins see a checkbox column, Edit and Delete buttons; general admins see read-only.
function renderAnswers(rows) {
  const tbody = document.getElementById('answersTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllAnswers');
  if (selectAll) selectAll.checked = false;
  tbody.innerHTML = rows.length
    ? rows.map(a => `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="answer-checkbox" data-id="${a.id}" ${selectedAnswerIds.has(a.id) ? 'checked' : ''} onchange="toggleAnswerSelection(${a.id}, this)"></td>` : ''}
          <td>${a.question_id}</td>
          <td><span class="pill pill-teal">${escapeHtml(SECTION_SHORT[a.section] || a.section || '-')}</span></td>
          <td class="min-w-[300px]">${escapeHtml(a.question_text)}</td>
          <td><span class="pill pill-green">Option ${escapeHtml(a.correct_option)}</span></td>
          ${isSuperAdmin() ? `<td><div class="flex gap-2">
            <button class="btn-icon btn-warning" title="Edit"   onclick="editAnswer(${a.id})">${ICON.edit}</button>
            <button class="btn-icon btn-danger"  title="Delete" onclick="deleteAnswer(${a.id})">${ICON.trash}</button>
          </div></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${isSuperAdmin() ? 6 : 4}" class="text-center text-slate-500 py-8">No answers found.</td></tr>`;
}

function toggleAnswerSelection(id, el) {
  if (el.checked) selectedAnswerIds.add(id);
  else selectedAnswerIds.delete(id);
  syncAnswersDeleteBtn();
}

function toggleSelectAllAnswers(el) {
  document.querySelectorAll('.answer-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedAnswerIds.add(id);
    else selectedAnswerIds.delete(id);
  });
  syncAnswersDeleteBtn();
}

function syncAnswersDeleteBtn() {
  const btn = document.getElementById('deleteSelectedAnswersBtn');
  if (!btn || !isSuperAdmin()) return;
  const show = selectedAnswerIds.size > 0;
  btn.classList.toggle('hidden', !show);
  if (show) btn.querySelector('span').textContent = `Delete Selected (${selectedAnswerIds.size})`;
}

async function deleteSelectedAnswers() {
  if (!selectedAnswerIds.size) return;
  const count = selectedAnswerIds.size;
  const ok = await showConfirm(
    `Delete ${count} answer(s)?`,
    'Delete Selected', 'Delete'
  );
  if (!ok) return;
  try {
    await Promise.all([...selectedAnswerIds].map(id => api(`/api/admin/answers/${id}`, { method: 'DELETE' })));
    selectedAnswerIds.clear();
    syncAnswersDeleteBtn();
    await showSuccess(`${count} answer(s) deleted.`, 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadAnswersAdmin();
}

async function loadAnswersAdmin() {
  if (!document.getElementById('answersTable')) return;
  try {
    allAnswers = (await api('/api/admin/answers')) || [];
    renderAnswers(allAnswers);
  } catch (err) {
    showError(err.message, 'Could Not Load Answers');
  }
}

document.getElementById('answerSearch')?.addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  renderAnswers(allAnswers.filter(a =>
    `${a.id} ${a.question_id} ${a.section} ${a.question_text} ${a.correct_option}`.toLowerCase().includes(term)
  ));
});

function editAnswer(id) {
  const a = allAnswers.find(a => Number(a.id) === Number(id));
  if (!a) return;
  document.getElementById('answer_id_edit').value = a.id;
  document.getElementById('question_id').value    = a.question_id;
  document.getElementById('correct_option').value = a.correct_option;
  document.getElementById('answerFormTitle').textContent = `Edit Answer #${a.id}`;
  document.getElementById('answerSubmitBtn').querySelector('span').textContent = 'Update Answer';
  document.getElementById('cancelAnswerEdit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetAnswerForm() {
  document.getElementById('answerForm')?.reset();
  document.getElementById('answer_id_edit').value = '';
  document.getElementById('answerFormTitle').textContent = 'Add / Update Correct Answer';
  document.getElementById('answerSubmitBtn').querySelector('span').textContent = 'Save Answer';
  document.getElementById('cancelAnswerEdit').classList.add('hidden');
}

document.getElementById('answerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id      = document.getElementById('answer_id_edit').value;
  const payload = {
    question_id:    Number(document.getElementById('question_id').value),
    correct_option: document.getElementById('correct_option').value,
  };
  try {
    await api(id ? `/api/admin/answers/${id}` : '/api/admin/answers', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    await showSuccess(id ? 'Answer updated.' : 'Answer saved.', 'Saved');
    resetAnswerForm();
    loadAnswersAdmin();
  } catch (err) {
    showError(err.message, 'Save Failed');
  }
});

async function deleteAnswer(id) {
  const ok = await showConfirm('Delete this answer record?', 'Delete Answer', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/answers/${id}`, { method: 'DELETE' });
    selectedAnswerIds.delete(id);
    syncAnswersDeleteBtn();
    await showSuccess('Answer deleted.', 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadAnswersAdmin();
}

async function uploadAnswers() {
  const file = document.getElementById('answerFile')?.files[0];
  if (!file) return showError('Please choose an Excel file first.', 'File Required');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res  = await fetch('/api/admin/answers/upload', { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
    await showSuccess(data.message || 'Answers uploaded.', 'Upload Complete');
    loadAnswersAdmin();
  } catch (err) {
    showError(err.message, 'Upload Failed');
  }
}

/* ── Participants ───────────────────────────────────────────── */

// Super admins see a checkbox column and per-row delete; general admins get read-only view.
function renderParticipants(rows) {
  const tbody = document.getElementById('participantsTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllParticipants');
  if (selectAll) selectAll.checked = false;
  const extra = isSuperAdmin() ? 2 : 0; // checkbox col + action col
  tbody.innerHTML = rows.length
    ? rows.map(p => `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="participant-checkbox" data-id="${p.id}" ${selectedParticipantIds.has(p.id) ? 'checked' : ''} onchange="toggleParticipantSelection(${p.id}, this)"></td>` : ''}
          <td><b>${escapeHtml(p.full_name)}</b></td>
          <td><code class="passcode-code" style="font-size:0.8rem">${escapeHtml(p.cid_number)}</code></td>
          <td>${escapeHtml(p.company_name || '-')}</td>
          <td>${escapeHtml(p.contact_number || '-')}</td>
          <td><span class="status-pill ${p.has_submitted ? 'active' : 'expired'}" style="${p.has_submitted ? '' : 'background:#f1f5f9;color:#64748b;border-color:#e2e8f0'}">${p.has_submitted ? 'Submitted' : 'Pending'}</span></td>
          ${isSuperAdmin() ? `<td><button class="btn-icon btn-danger" title="Delete" onclick="deleteParticipant(${p.id}, '${escapeHtml(p.full_name)}', ${p.has_submitted})">${ICON.trash}</button></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${5 + extra}" class="text-center text-slate-500 py-8">No participants registered yet.</td></tr>`;
}

async function loadParticipantsAdmin() {
  if (!document.getElementById('participantsTable')) return;
  try {
    allParticipants = await api('/api/admin/participants');
    renderParticipants(allParticipants);
  } catch (err) {
    showError(err.message, 'Could Not Load Participants');
  }
}

document.getElementById('participantSearch')?.addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  renderParticipants(allParticipants.filter(p =>
    `${p.full_name} ${p.cid_number} ${p.company_name} ${p.contact_number}`.toLowerCase().includes(term)
  ));
});

document.getElementById('participantForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/participants', {
      method: 'POST',
      body: JSON.stringify({
        full_name:      document.getElementById('p_full_name').value.trim(),
        cid_number:     document.getElementById('p_cid_number').value.trim(),
        company_name:   document.getElementById('p_company_name').value.trim(),
        contact_number: document.getElementById('p_contact_number').value.trim(),
      }),
    });
    await showSuccess('Participant added.', 'Added');
    document.getElementById('participantForm').reset();
    loadParticipantsAdmin();
  } catch (err) {
    showError(err.message, 'Add Failed');
  }
});

// Deleting a submitted participant also removes their submission via ON DELETE CASCADE.
async function deleteParticipant(id, name, hasSubmitted) {
  const msg = hasSubmitted
    ? `Delete "${name}"? They have already submitted — their test result will also be deleted.`
    : `Delete "${name}"? They will no longer be able to access the test.`;
  const ok = await showConfirm(msg, 'Delete Participant', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/participants/${id}`, { method: 'DELETE' });
    selectedParticipantIds.delete(id);
    syncParticipantsDeleteBtn();
    await showSuccess('Participant deleted.', 'Deleted');
    loadParticipantsAdmin();
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
}

async function uploadParticipants() {
  const input = document.getElementById('participantFile');
  const file  = input?.files[0];
  if (!file) return showError('Please choose an Excel file first.', 'File Required');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res  = await fetch('/api/admin/participants/upload', { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
    await showSuccess(`${data.added || 0} added, ${data.skipped || 0} skipped (duplicate CIDs).`, 'Upload Complete');
    if (input) input.value = '';
    loadParticipantsAdmin();
  } catch (err) {
    showError(err.message, 'Upload Failed');
  }
}

function toggleParticipantSelection(id, el) {
  if (el.checked) selectedParticipantIds.add(id);
  else selectedParticipantIds.delete(id);
  syncParticipantsDeleteBtn();
}

function toggleSelectAllParticipants(el) {
  document.querySelectorAll('.participant-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedParticipantIds.add(id);
    else selectedParticipantIds.delete(id);
  });
  syncParticipantsDeleteBtn();
}

// Shows/hides the "Delete Selected" button for participants and keeps its count label current.
function syncParticipantsDeleteBtn() {
  const btn = document.getElementById('deleteSelectedParticipantsBtn');
  if (!btn || !isSuperAdmin()) return;
  const show = selectedParticipantIds.size > 0;
  btn.classList.toggle('hidden', !show);
  if (show) btn.querySelector('span').textContent = `Delete Selected (${selectedParticipantIds.size})`;
}

async function deleteSelectedParticipants() {
  if (!selectedParticipantIds.size) return;
  const count = selectedParticipantIds.size;
  const ok = await showConfirm(
    `Delete ${count} participant(s)? Submitted test results will also be deleted.`,
    'Delete Selected', 'Delete'
  );
  if (!ok) return;
  try {
    await Promise.all([...selectedParticipantIds].map(id => api(`/api/admin/participants/${id}`, { method: 'DELETE' })));
    selectedParticipantIds.clear();
    syncParticipantsDeleteBtn();
    await showSuccess(`${count} participant(s) deleted.`, 'Deleted');
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
  loadParticipantsAdmin(); // reload regardless of partial failures
}

/* ── Admin users ───────────────────────────────────────────── */

function renderAdminUsers(rows) {
  const tbody = document.getElementById('adminsTable');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-slate-500 py-8">No admin users found.</td></tr>`;
    return;
  }

  // Current logged-in admin always appears first; rest retain their original order.
  const sorted = [
    ...rows.filter(a => a.id === currentAdmin.id),
    ...rows.filter(a => a.id !== currentAdmin.id),
  ];

  tbody.innerHTML = sorted.map((a, idx) => {
    // Super admins cannot edit their own role (would allow accidental self-demotion).
    const isSelf      = a.id === currentAdmin.id;
    const roleEditBtn = isSelf ? '' :
      `<button class="btn-icon btn-soft" title="Change Role" onclick="changeAdminRole(${a.id}, '${a.role}', '${escapeHtml(a.username)}')">${ICON.shield}</button>`;
    return `
      <tr>
        <td><span class="pill">${idx + 1}</span></td>
        <td>
          <b>${escapeHtml(a.username)}</b>
          ${isSelf ? '<br><span class="text-xs text-slate-400 font-semibold">(you)</span>' : ''}
        </td>
        <td><span class="pill ${a.role === 'super_admin' ? 'pill-teal' : ''}">${a.role === 'super_admin' ? 'Super Admin' : 'General Admin'}</span></td>
        <td><span class="status-pill ${a.is_active ? 'active' : 'expired'}">${a.is_active ? 'Active' : 'Revoked'}</span></td>
        <td>
          <div class="flex gap-2 flex-wrap">
            ${roleEditBtn}
            <button class="btn-icon btn-warning" title="Change Password" onclick="changeAdminPassword(${a.id}, '${escapeHtml(a.username)}')">${ICON.key}</button>
            <button class="btn-icon ${a.is_active ? 'btn-danger' : 'btn-small'}" title="${a.is_active ? 'Revoke' : 'Activate'}" onclick="setAdminAccess(${a.id}, ${!a.is_active})">${a.is_active ? ICON.lock : ICON.unlock}</button>
            ${isSelf ? '' : `<button class="btn-icon btn-danger" title="Delete" onclick="deleteAdminUser(${a.id}, '${escapeHtml(a.username)}')">${ICON.trash}</button>`}
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function loadAdminUsers() {
  if (!document.getElementById('adminsTable')) return;
  try {
    const rows = await api('/api/admin/users');
    renderAdminUsers(rows);
  } catch (err) {
    showError(err.message, 'Could Not Load Admins');
  }
}

document.getElementById('adminUserForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('new_admin_username').value,
        password: document.getElementById('new_admin_password').value,
        role:     document.getElementById('new_admin_role').value,
      }),
    });
    await showSuccess('Admin user created.', 'Created');
    document.getElementById('adminUserForm').reset();
    loadAdminUsers();
  } catch (err) {
    showError(err.message, 'Create Failed');
  }
});

async function setAdminAccess(id, active) {
  const ok = await showConfirm(
    active ? 'Activate this admin account?' : 'Revoke access for this admin account?',
    'Confirm', active ? 'Activate' : 'Revoke'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/users/${id}/access`, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
    await showSuccess('Admin access updated.', 'Updated');
    loadAdminUsers();
  } catch (err) {
    showError(err.message, 'Update Failed');
  }
}

async function changeAdminPassword(id, username) {
  const password = await showPasswordModal(`Set new password for ${username}`);
  if (!password) return;
  try {
    await api(`/api/admin/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
    await showSuccess('Password changed. The admin must log in again.', 'Changed');
    loadAdminUsers();
  } catch (err) {
    showError(err.message, 'Password Change Failed');
  }
}

async function changeAdminRole(id, currentRole, username) {
  const newRole = await showRoleModal(username, currentRole);
  if (!newRole || newRole === currentRole) return;
  const label = newRole === 'super_admin' ? 'Super Admin' : 'General Admin';
  const ok = await showConfirm(
    `Change role for "${username}" to ${label}? Their current session will be invalidated and they must log in again.`,
    'Change Role', 'Confirm'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
    await showSuccess(`Role updated to ${label}. The admin must log in again.`, 'Role Updated');
    loadAdminUsers();
  } catch (err) {
    showError(err.message, 'Role Change Failed');
  }
}

// Shows a modal with a role <select> dropdown. Resolves with the chosen role string,
// or '' if the admin cancels without changing anything.
function showRoleModal(username, currentRole) {
  return new Promise((resolve) => {
    const modal      = ensureAppModal();
    const confirmBtn = document.getElementById('appModalConfirm');
    const cancelBtn  = document.getElementById('appModalCancel');

    document.getElementById('appModalIcon').className   = 'app-modal-icon info';
    document.getElementById('appModalIcon').textContent = '🛡';
    document.getElementById('appModalTitle').textContent = `Change Role — ${username}`;
    document.getElementById('appModalBody').innerHTML = `
      <label class="block text-sm font-semibold text-slate-700 mb-2">Select new role</label>
      <select id="modalRoleSelect" class="input w-full">
        <option value="general_admin" ${currentRole === 'general_admin' ? 'selected' : ''}>General Admin</option>
        <option value="super_admin"   ${currentRole === 'super_admin'   ? 'selected' : ''}>Super Admin</option>
      </select>`;

    confirmBtn.textContent = 'Update Role';
    cancelBtn.textContent  = 'Cancel';
    cancelBtn.classList.remove('hidden');
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const close = (val) => {
      modal.classList.add('hidden');
      document.body.classList.remove('modal-open');
      confirmBtn.onclick = null;
      cancelBtn.onclick  = null;
      resolve(val);
    };

    confirmBtn.onclick = () => close(document.getElementById('modalRoleSelect').value);
    cancelBtn.onclick  = () => close('');
    setTimeout(() => document.getElementById('modalRoleSelect')?.focus(), 50);
  });
}

async function deleteAdminUser(id, username) {
  const ok = await showConfirm(`Permanently delete admin "${username}"? This cannot be undone.`, 'Delete Admin', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    await showSuccess('Admin deleted.', 'Deleted');
    loadAdminUsers();
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
}

// Reuses the shared app modal with a password input field.
// Resolves with the entered password, or '' if the admin cancels.
function showPasswordModal(title) {
  return new Promise((resolve) => {
    const modal      = ensureAppModal();
    const confirmBtn = document.getElementById('appModalConfirm');
    const cancelBtn  = document.getElementById('appModalCancel');

    document.getElementById('appModalIcon').className   = 'app-modal-icon info';
    document.getElementById('appModalIcon').textContent = '🔐';
    document.getElementById('appModalTitle').textContent = title;
    document.getElementById('appModalBody').innerHTML   =
      `<input id="modalPasswordInput" type="password" class="input" placeholder="New password (min 6 characters)" minlength="6">`;

    confirmBtn.textContent = 'Change Password';
    cancelBtn.textContent  = 'Cancel';
    cancelBtn.classList.remove('hidden');
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const close = (val) => {
      modal.classList.add('hidden');
      document.body.classList.remove('modal-open');
      confirmBtn.onclick = null;
      cancelBtn.onclick  = null;
      resolve(val);
    };

    confirmBtn.onclick = () => {
      const val = document.getElementById('modalPasswordInput').value.trim();
      if (val.length >= 6) close(val); // silently enforce minimum length
    };
    cancelBtn.onclick = () => close('');
    setTimeout(() => document.getElementById('modalPasswordInput')?.focus(), 50);
  });
}

/* ── Initialisation ────────────────────────────────────────── */

// Entry point — runs once on every admin page load.
// Each load function guards itself with a getElementById() check, so only the
// relevant loaders actually do work on the current page.
async function initAdminPages() {
  await loadCurrentAdmin();

  // applyRoleUI() handles the redirect; just stop rendering restricted pages early.
  const page = location.pathname.split('/').pop();
  if (!isSuperAdmin() && (page === 'passcodes.html' || page === 'admins.html')) return;

  loadDashboard();
  startDashboardAutoRefresh();
  loadPasscodes();
  // Auto-refresh passcodes every 15s so the Active/Expired status stays accurate.
  if (document.getElementById('passcodesTable')) setInterval(loadPasscodes, 15000);
  loadQuestionsAdmin();
  loadAnswersAdmin();
  loadParticipantsAdmin();
  loadAdminUsers();
}

initAdminPages();
