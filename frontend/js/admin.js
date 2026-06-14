/* ============================================================
   admin.js  —  All admin panel logic
   ============================================================ */

/* ── Module state ──────────────────────────────────────────── */
let allResults          = [];
let allQuestions        = [];
let allAnswers          = [];
let allPasscodes        = [];
let allParticipants     = [];
let allSections         = []; // from /api/admin/settings/sections
let currentAdmin        = { id: 0, role: '', username: '' };
let dashboardTimer      = null;

let selectedResultIds      = new Set();
let selectedParticipantIds = new Set();
let selectedQuestionIds    = new Set();
let selectedAnswerIds      = new Set();
let currentResultDetail    = null;
let pendingSaveMode        = 'save'; // 'save' | 'add_another'

/* ── Template download helper ──────────────────────────────── */

// downloadTemplate fetches an Excel template from the given API URL and triggers
// a browser file-save. Using fetch+blob instead of a plain <a href download> means
// auth failures and server errors are caught and shown as a proper UI error rather
// than silently downloading a corrupt/JSON file.
async function downloadTemplate(url, filename) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      let msg = 'Could not download template.';
      try { msg = (await res.json()).error || msg; } catch { /* use default */ }
      showError(msg + (res.status === 500 ? ' Make sure at least one active section is configured in Settings.' : ''), 'Download Failed');
      return;
    }
    const blob = await res.blob();
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showError(err.message || 'Network error. Please try again.', 'Download Failed');
  }
}

/* ── Icon SVGs ─────────────────────────────────────────────── */
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
  image:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
};

/* ── Section colour palette ────────────────────────────────── */
// Each entry: [barGradient, badgeBg, badgeColor, itemAccent]
const SECTION_PALETTE = [
  ['linear-gradient(90deg,#f97316,#fbbf24)', '#fff7ed', '#c2410c', '#c2410c'],
  ['linear-gradient(90deg,#2563eb,#60a5fa)', '#eff6ff', '#1d4ed8', '#1d4ed8'],
  ['linear-gradient(90deg,#16a34a,#2dd4bf)', '#dcfce7', '#166534', '#166534'],
  ['linear-gradient(90deg,#7c3aed,#a78bfa)', '#f5f3ff', '#5b21b6', '#5b21b6'],
  ['linear-gradient(90deg,#db2777,#f472b6)', '#fdf2f8', '#9d174d', '#9d174d'],
  ['linear-gradient(90deg,#0891b2,#67e8f9)', '#ecfeff', '#155e75', '#155e75'],
];

// Returns the palette entry for a section by its position in allSections.
function sectionPalette(sectionName) {
  const idx = allSections.findIndex(s => s.name === sectionName);
  return SECTION_PALETTE[(idx >= 0 ? idx : 0) % SECTION_PALETTE.length];
}

/* ── Auth ──────────────────────────────────────────────────── */

function isSuperAdmin() { return currentAdmin.role === 'super_admin'; }

async function loadCurrentAdmin() {
  if (!document.body.classList.contains('admin-body') || document.getElementById('adminLoginForm')) return;
  try {
    currentAdmin = await api('/api/admin/me');
    applyRoleUI();
  } catch {
    window.location.href = 'admin-login.html';
  }
}

function applyRoleUI() {
  const isSuper = isSuperAdmin();
  document.querySelectorAll('.super-only').forEach(el => el.classList.toggle('hidden', !isSuper));
  if (!isSuper) {
    document.querySelectorAll('.management-panel').forEach(el => el.classList.add('hidden'));
  }
  const page = location.pathname.split('/').pop();
  if (!isSuper && (page === 'passcodes.html' || page === 'admins.html' || page === 'test-settings.html')) {
    showError('Only super admins can access this page.', 'Access Restricted')
      .then(() => window.location.href = 'admin-dashboard.html');
  }
}

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

async function logout() {
  const ok = await showConfirm('Do you want to securely exit the admin panel?', 'Logout', 'Logout');
  if (!ok) return;
  try { await api('/api/admin/logout', { method: 'POST' }); } finally {
    window.location.href = 'admin-login.html';
  }
}

/* ── Settings (test config + sections) ────────────────────── */

async function loadSections() {
  try {
    allSections = (await api('/api/admin/settings/sections')) || [];
  } catch { allSections = []; }
  renderSectionsTable();
  populateSectionDropdown();
  renderBankSummary();
}

function renderSectionsTable() {
  const tbody = document.getElementById('sectionsTable');
  if (!tbody) return;
  const empty = document.getElementById('sectionsEmpty');
  if (!allSections.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  tbody.innerHTML = allSections.map(s => `
    <tr${!s.is_active ? ' style="opacity:.55"' : ''}>
      <td><span class="pill pill-teal">${escapeHtml(s.label || '—')}</span></td>
      <td><b>${escapeHtml(s.name)}</b></td>
      <td class="text-center">${s.questions_per_test}</td>
      <td class="text-center">${s.bank_count ?? '—'}</td>
      <td class="text-center text-slate-500 text-sm">${s.sort_order}</td>
      <td class="text-center"><span class="status-pill ${s.is_active ? 'active' : 'expired'}">${s.is_active ? 'Active' : 'Inactive'}</span></td>
      ${isSuperAdmin() ? `<td>
        <div class="flex gap-1.5">
          <button class="btn-icon btn-warning" title="Edit" onclick="editSection(${s.id})">${ICON.edit}</button>
          <button class="btn-icon btn-danger"  title="Delete" onclick="deleteSection(${s.id})">${ICON.trash}</button>
        </div>
      </td>` : ''}
    </tr>`).join('');
}

function populateSectionDropdown(selectName) {
  const sel = document.getElementById('question_section');
  if (!sel) return;
  if (!allSections.length) {
    sel.innerHTML = '<option value="" disabled selected>No sections yet — create one below</option>';
    return;
  }
  const activeSections = allSections.filter(s => s.is_active);
  if (!activeSections.length) {
    sel.innerHTML = '<option value="" disabled selected>No active sections — enable one in Settings</option>';
    return;
  }
  const current = selectName || (sel.value && sel.value !== '' ? sel.value : null);
  sel.innerHTML = activeSections.map(s =>
    `<option value="${escapeHtml(s.name)}" ${s.name === current ? 'selected' : ''}>${escapeHtml(s.label ? s.label + ' — ' : '')}${escapeHtml(s.name)}</option>`
  ).join('');
  if (selectName) sel.value = selectName;
  else if (!sel.value && activeSections.length) sel.value = activeSections[0].name;
}

function toggleQuickAddSection() {
  const panel = document.getElementById('quickAddSectionPanel');
  if (!panel) return;
  const isOpening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  const btn = document.getElementById('toggleNewSectionBtn');
  if (btn) {
    btn.classList.toggle('text-blue-600', !isOpening);
    btn.classList.toggle('text-red-500', isOpening);
  }
  if (isOpening) document.getElementById('quickSectionName')?.focus();
}

async function quickAddSection() {
  const name   = document.getElementById('quickSectionName')?.value.trim();
  const label  = document.getElementById('quickSectionLabel')?.value.trim() || '';
  const qcount = Number(document.getElementById('quickSectionQCount')?.value) || 16;
  const msg    = document.getElementById('quickSectionMsg');
  if (!name) {
    if (msg) { msg.textContent = 'Section name is required.'; msg.style.color = '#dc2626'; }
    return;
  }
  try {
    await api('/api/admin/settings/sections', {
      method: 'POST',
      body: JSON.stringify({ name, label, questions_per_test: qcount || 10, sort_order: allSections.length + 1, is_active: true }),
    });
    await loadSections();
    populateSectionDropdown(name);
    toggleQuickAddSection();
    document.getElementById('quickSectionName').value   = '';
    document.getElementById('quickSectionLabel').value  = '';
    document.getElementById('quickSectionQCount').value = '';
    if (msg) msg.textContent = '';
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.style.color = '#dc2626'; }
  }
}

function renderBankSummary() {
  const wrap = document.getElementById('bankSummary');
  if (!wrap) return;
  if (!allSections.length) { wrap.innerHTML = '<p class="text-slate-400 text-sm col-span-full py-4">No sections yet. Use <b>Add New Section</b> above to create one.</p>'; return; }
  const colors = ['orange', 'blue', 'green', 'purple', 'teal', 'rose'];
  const isSuper = isSuperAdmin();
  wrap.innerHTML = allSections.map((s, i) => {
    const col      = colors[i % colors.length];
    const inactive = !s.is_active;
    const bankQ    = allQuestions.filter(q => q.section === s.name).length;
    const enough   = bankQ >= s.questions_per_test;
    const zero     = bankQ === 0;
    const countCol = inactive ? 'text-slate-300' : (zero ? 'text-slate-400' : (enough ? 'text-slate-800' : 'text-red-600'));
    const actionBtns = isSuper ? `
      <div class="flex gap-1 ml-auto flex-shrink-0 self-start">
        <button class="btn-icon btn-warning" style="width:1.75rem;height:1.75rem" title="Edit section" onclick="toggleBankCardEdit(${s.id})">${ICON.edit}</button>
        <button class="btn-icon btn-danger"  style="width:1.75rem;height:1.75rem" title="Delete section" onclick="deleteSectionFromCard(${s.id})">${ICON.trash}</button>
      </div>` : '';
    const editPanel = isSuper ? `
      <div id="bankCardEdit_${s.id}" class="hidden mt-3 pt-3 border-t border-slate-200">
        <p class="text-xs font-black text-slate-500 mb-2 uppercase tracking-widest">Edit Section</p>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label class="block text-xs font-bold text-slate-400 mb-1">Section Name</label>
            <input id="bce_name_${s.id}" class="input text-sm py-1.5" value="${escapeHtml(s.name)}" placeholder="e.g. Logical Reasoning" required>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-400 mb-1">Display Label</label>
            <input id="bce_label_${s.id}" class="input text-sm py-1.5" value="${escapeHtml(s.label)}" placeholder="e.g. Section A">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-400 mb-1">Questions / Test</label>
            <input id="bce_qcount_${s.id}" type="number" min="1" class="input text-sm py-1.5" value="${s.questions_per_test}" placeholder="e.g. 10">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-400 mb-1">Sort Order</label>
            <input id="bce_order_${s.id}" type="number" min="0" class="input text-sm py-1.5" value="${s.sort_order}" placeholder="1">
          </div>
        </div>
        <div class="flex items-center gap-2 mb-2">
          <input id="bce_active_${s.id}" type="checkbox" ${s.is_active ? 'checked' : ''} class="w-4 h-4 accent-orange-500">
          <label for="bce_active_${s.id}" class="text-xs font-bold text-slate-600 cursor-pointer">Active (shown in tests)</label>
        </div>
        <div class="flex gap-2">
          <button class="btn text-xs px-3 py-1.5 flex items-center gap-1" onclick="saveBankCardEdit(${s.id})">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            Save
          </button>
          <button class="btn-outline text-xs px-3 py-1.5" onclick="toggleBankCardEdit(${s.id})">Cancel</button>
          <span id="bce_msg_${s.id}" class="text-xs font-semibold self-center ml-1"></span>
        </div>
      </div>` : '';
    const statusHtml = inactive
      ? `<span class="inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 uppercase tracking-wide border border-slate-200">Inactive</span>`
      : zero
        ? `<span class="text-xs text-slate-400 font-semibold">No questions yet</span>`
        : !enough
          ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-red-600"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Need ${s.questions_per_test - bankQ} more</span>`
          : `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-green-600"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>Ready</span>`;

    return `
      <div class="card p-4${inactive ? ' opacity-55' : ''}" id="bankCard_${s.id}">

        <!-- Header row: number badge · label · name · actions -->
        <div class="flex items-start gap-3 mb-3">
          <!-- Numbered circle — always just the index, never the full label text -->
          <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 font-black text-lg bg-${col}-100 text-${col}-600 border border-${col}-200">
            ${i + 1}
          </div>
          <div class="flex-1 min-w-0">
            ${s.label ? `<p class="text-xs font-black text-${col}-600 uppercase tracking-wider leading-none mb-0.5">${escapeHtml(s.label)}</p>` : ''}
            <p class="text-sm font-extrabold text-slate-800 leading-snug">${escapeHtml(s.name)}</p>
          </div>
          ${actionBtns}
        </div>

        <!-- Stats row -->
        <div class="flex items-center gap-3 mb-2">
          <div class="flex-1 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p class="text-2xl font-black leading-none ${countCol}">${bankQ}</p>
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide mt-0.5">In Bank</p>
          </div>
          <div class="flex-1 rounded-lg bg-${col}-50 border border-${col}-100 px-3 py-2 text-center">
            <p class="text-2xl font-black leading-none text-${col}-600">${s.questions_per_test}</p>
            <p class="text-[10px] font-bold text-${col}-400 uppercase tracking-wide mt-0.5">Per Test</p>
          </div>
        </div>

        <!-- Status line -->
        <div class="flex items-center justify-between">
          ${statusHtml}
        </div>

        ${editPanel}
      </div>`;
  }).join('');
}

function toggleBankCardEdit(id) {
  document.getElementById(`bankCardEdit_${id}`)?.classList.toggle('hidden');
}

async function saveBankCardEdit(id) {
  const s      = allSections.find(s => s.id === id);
  if (!s) return;
  const name   = document.getElementById(`bce_name_${id}`)?.value.trim() || s.name;
  const label  = document.getElementById(`bce_label_${id}`)?.value.trim() ?? s.label;
  const qcount = Number(document.getElementById(`bce_qcount_${id}`)?.value);
  const order  = Number(document.getElementById(`bce_order_${id}`)?.value) || s.sort_order;
  const active = document.getElementById(`bce_active_${id}`)?.checked ?? s.is_active;
  const msg    = document.getElementById(`bce_msg_${id}`);
  if (!name) {
    if (msg) { msg.textContent = 'Section name is required'; msg.style.color = '#dc2626'; }
    return;
  }
  if (!qcount || qcount < 1) {
    if (msg) { msg.textContent = 'Enter a number ≥ 1'; msg.style.color = '#dc2626'; }
    return;
  }
  try {
    await api(`/api/admin/settings/sections/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, label, questions_per_test: qcount, sort_order: order, is_active: active }),
    });
    await loadSections();
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.style.color = '#dc2626'; }
  }
}

async function deleteSectionFromCard(id) {
  const s = allSections.find(s => s.id === id);
  if (!s) return;
  const bankQ = allQuestions.filter(q => q.section === s.name).length;
  const qWarning = bankQ > 0
    ? `\n\nThis will also permanently delete all ${bankQ} question(s) in this section.`
    : '';
  const ok = await showConfirm(
    `Delete section "${s.name}"?${qWarning}`,
    'Delete Section', 'Delete'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/settings/sections/${id}`, { method: 'DELETE' });
    await showSuccess('Section and its questions deleted.', 'Deleted');
    await loadSections();
    loadQuestionsAdmin();
  } catch (err) { showError(err.message, 'Delete Failed'); }
}

async function loadTestConfigForm() {
  const form = document.getElementById('configForm');
  if (!form) return;
  try {
    const cfg = await api('/api/admin/settings/config');
    document.getElementById('test_duration').value   = cfg.test_duration_minutes   || 60;
    document.getElementById('passcode_validity').value = cfg.passcode_validity_minutes || 90;
  } catch { /* leave defaults */ }
}

document.getElementById('configForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('configMsg');
  try {
    await api('/api/admin/settings/config', {
      method: 'PUT',
      body: JSON.stringify({
        test_duration_minutes:     Number(document.getElementById('test_duration').value),
        passcode_validity_minutes: Number(document.getElementById('passcode_validity').value),
      }),
    });
    if (msg) { msg.textContent = '✓ Configuration saved.'; msg.style.color = '#16a34a'; }
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.style.color = '#dc2626'; }
  }
});

document.getElementById('sectionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id    = document.getElementById('section_id_edit').value;
  const body  = {
    name:               document.getElementById('section_name').value.trim(),
    label:              document.getElementById('section_label').value.trim(),
    questions_per_test: Number(document.getElementById('section_qcount').value),
    sort_order:         Number(document.getElementById('section_order').value) || 0,
    is_active:          document.getElementById('section_active').checked,
  };
  const msg = document.getElementById('sectionMsg');
  try {
    await api(id ? `/api/admin/settings/sections/${id}` : '/api/admin/settings/sections', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    if (msg) { msg.textContent = id ? '✓ Section updated.' : '✓ Section added.'; msg.style.color = '#16a34a'; }
    setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
    resetSectionForm();
    loadSections();
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.style.color = '#dc2626'; }
  }
});

function editSection(id) {
  const s = allSections.find(s => s.id === id);
  if (!s) return;
  document.getElementById('section_id_edit').value = s.id;
  document.getElementById('section_name').value    = s.name;
  document.getElementById('section_label').value   = s.label;
  document.getElementById('section_qcount').value  = s.questions_per_test;
  document.getElementById('section_order').value   = s.sort_order;
  document.getElementById('section_active').checked = s.is_active;
  document.getElementById('sectionFormTitle').textContent = `Edit Section`;
  document.getElementById('sectionSubmitLabel').textContent = 'Update Section';
  document.getElementById('cancelSectionEdit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetSectionForm() {
  document.getElementById('sectionForm')?.reset();
  document.getElementById('section_id_edit').value = '';
  document.getElementById('sectionFormTitle').textContent = 'Add Section';
  document.getElementById('sectionSubmitLabel').textContent = 'Save Section';
  document.getElementById('cancelSectionEdit')?.classList.add('hidden');
  document.getElementById('section_active').checked = true;
}

async function deleteSection(id) {
  const s = allSections.find(s => s.id === id);
  const bankQ = allQuestions.filter(q => q.section === s?.name).length;
  const qWarning = bankQ > 0 ? ` This will also permanently delete all ${bankQ} question(s) in this section.` : '';
  const ok = await showConfirm(
    `Delete section "${s?.name}"?${qWarning}`,
    'Delete Section', 'Delete'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/settings/sections/${id}`, { method: 'DELETE' });
    await showSuccess('Section and its questions have been deleted.', 'Deleted');
    await loadSections();
    loadQuestionsAdmin();
  } catch (err) {
    showError(err.message, 'Delete Failed');
  }
}

/* ── Dashboard ─────────────────────────────────────────────── */

async function loadDashboard(showErrors = true) {
  if (!document.getElementById('summary')) return;
  try {
    const s          = await api('/api/admin/dashboard');
    const appeared   = s.appeared_participants || 0;
    const registered = s.total_participants    || 0;
    const turnout    = registered ? Math.round((appeared / registered) * 100) : 0;
    const totalQ     = allSections.reduce((sum, s) => sum + s.questions_per_test, 0);
    const outOf      = totalQ ? `<small>/${totalQ}</small>` : '';

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
        <p class="metric-label">Highest Score</p><p class="metric-value">${s.highest_score || 0}${outOf}</p><p class="metric-note">Top performer</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon purple"><svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span>
        <p class="metric-label">Average Score</p><p class="metric-value">${Number(s.average_score || 0).toFixed(1)}${outOf}</p><p class="metric-note">Overall average</p>
      </div>
      <div class="card metric-card card-hover">
        <span class="metric-icon rose"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></span>
        <p class="metric-label">Lowest Score</p><p class="metric-value">${s.lowest_score || 0}${outOf}</p><p class="metric-note">Minimum score</p>
      </div>`;

    allResults = await api('/api/admin/results');
    renderResultsTableHeader();
    renderResults(filterResults(allResults));
    renderCharts(allResults, appeared, registered);
  } catch (err) {
    if (showErrors) {
      showError('Session expired or dashboard failed to load.', 'Dashboard Error')
        .then(() => window.location.href = 'admin-login.html');
    }
  }
}

function filterResults(rows) {
  const term = (document.getElementById('resultSearch')?.value || '').toLowerCase();
  if (!term) return rows;
  return rows.filter(r =>
    `${r.full_name} ${r.cid_number} ${r.company_name} ${r.contact_number}`.toLowerCase().includes(term)
  );
}

document.getElementById('resultSearch')?.addEventListener('input', () => renderResults(filterResults(allResults)));

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

function renderSectionChart(rows) {
  const el = document.getElementById('sectionChart');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="empty-chart">No results yet. Charts appear after participants submit the test.</div>`;
    return;
  }
  // If sections haven't loaded yet, derive them from the results' section_score data.
  const sections = allSections.length ? allSections : (() => {
    const seen = {}, derived = [];
    rows.forEach(r => (r.section_scores || []).forEach(ss => {
      if (!seen[ss.section_name]) {
        seen[ss.section_name] = true;
        derived.push({ name: ss.section_name, label: ss.section_name, questions_per_test: ss.questions_count || 1 });
      }
    }));
    return derived;
  })();
  if (!sections.length) { el.innerHTML = `<div class="empty-chart">No section data available.</div>`; return; }
  const n = rows.length;
  el.innerHTML = sections.map(sec => {
    let total = 0;
    rows.forEach(r => {
      const ss = (r.section_scores || []).find(s => s.section_name === sec.name);
      if (ss) { total += ss.score; }
      else if (sec.name === 'Analytical Ability')  total += r.analytical_score  || 0;
      else if (sec.name === 'Verbal Ability')       total += r.verbal_score      || 0;
      else if (sec.name === 'Quantitative Skills')  total += r.quantitative_score || 0;
    });
    const avg     = total / n;
    const percent = Math.min(100, (avg / sec.questions_per_test) * 100);
    const label   = sec.label || sec.name;
    const [barGrad] = sectionPalette(sec.name);
    return `
      <div class="chart-row">
        <div class="chart-row-head"><span>${escapeHtml(label)}</span><b>${avg.toFixed(1)}/${sec.questions_per_test}</b></div>
        <div class="bar-track"><span class="bar-fill" style="width:${percent}%;background:${barGrad}"></span></div>
      </div>`;
  }).join('');

  const subtitle = document.getElementById('sectionChartSubtitle');
  if (subtitle && allSections.length) {
    const qs = allSections.map(s => s.questions_per_test).join('/');
    subtitle.textContent = `${qs} per section`;
  }
}

function renderTurnoutChart(appeared, total) {
  const el = document.getElementById('turnoutChart');
  if (!el) return;
  if (!total) { el.innerHTML = `<div class="empty-chart">No participants registered yet.</div>`; return; }
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
            <stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#14b8a6"/>
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="${r}" class="donut-track"/>
        <circle cx="60" cy="60" r="${r}" class="donut-fill"
          stroke-dasharray="${dash} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"/>
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

function renderDistributionChart(rows) {
  const el = document.getElementById('distributionChart');
  if (!el) return;
  if (!rows.length) { el.innerHTML = `<div class="empty-chart">No score distribution yet.</div>`; return; }
  const totalQ = allSections.reduce((sum, s) => sum + s.questions_per_test, 0)
    || Math.max(10, ...rows.map(r => Number(r.score || 0)));
  const step = Math.ceil(totalQ / 5);
  const buckets = [];
  for (let i = 0; i < 5; i++) {
    const min = i * step;
    const max = i === 4 ? totalQ : (i + 1) * step - 1;
    buckets.push({ label: `${min}–${max}`, min, max });
  }
  buckets.forEach(b => { b.count = rows.filter(r => Number(r.score || 0) >= b.min && Number(r.score || 0) <= b.max).length; });
  const max = Math.max(1, ...buckets.map(b => b.count));
  el.innerHTML = buckets.map(b => `
    <div class="dist-row">
      <span>${b.label}</span>
      <div class="dist-track"><i style="width:${(b.count / max) * 100}%"></i></div>
      <b>${b.count}</b>
    </div>`).join('');
}

/* ── Results table ─────────────────────────────────────────── */

function renderResultsTableHeader() {
  const header = document.getElementById('resultsTableHeader');
  if (!header) return;
  const totalQ = allSections.reduce((sum, s) => sum + s.questions_per_test, 0);
  const sectionHeaders = allSections.length
    ? allSections.map(s => {
        const [, bg, color] = sectionPalette(s.name);
        return `<th>${escapeHtml(s.label || s.name)}<br><span style="color:${color}">${s.questions_per_test} questions</span></th>`;
      }).join('')
    : '';
  header.innerHTML = `
    ${isSuperAdmin() ? '<th style="width:40px"><input type="checkbox" id="selectAllResults" title="Select all" onchange="toggleSelectAllResults(this)"></th>' : ''}
    <th>Serial No.</th>
    <th>Name of Candidate</th>
    <th>Total Score${totalQ ? `<br><span>Out of ${totalQ}</span>` : ''}</th>
    ${sectionHeaders}
    <th>Rank</th>
    <th>Contact</th>
    <th>Details</th>
    ${isSuperAdmin() ? '<th>Action</th>' : ''}`;
}

function renderResults(rows) {
  const tbody = document.getElementById('results');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllResults');
  if (selectAll) selectAll.checked = false;
  const totalQ    = allSections.reduce((sum, s) => sum + s.questions_per_test, 0);
  const colSpan   = 6 + (isSuperAdmin() ? 2 : 0) + allSections.length;

  const sectionScoreCols = (r) => {
    const scoreByName = {};
    (r.section_scores || []).forEach(ss => { scoreByName[ss.section_name] = ss; });
    const hasNew = r.section_scores && r.section_scores.length > 0;

    if (allSections.length) {
      return allSections.map(sec => {
        const [, bg, color] = sectionPalette(sec.name);
        if (hasNew) {
          const ss = scoreByName[sec.name];
          const score = ss ? ss.score : 0;
          const total = ss ? ss.questions_count : sec.questions_per_test;
          return `<td><span class="score-badge" style="background:${bg};color:${color}">${score}/${total}</span></td>`;
        }
        if (sec.name === 'Analytical Ability')  return `<td><span class="score-badge" style="background:${bg};color:${color}">${r.analytical_score}/16</span></td>`;
        if (sec.name === 'Verbal Ability')       return `<td><span class="score-badge" style="background:${bg};color:${color}">${r.verbal_score}/16</span></td>`;
        if (sec.name === 'Quantitative Skills')  return `<td><span class="score-badge" style="background:${bg};color:${color}">${r.quantitative_score}/16</span></td>`;
        return `<td>—</td>`;
      }).join('');
    }
    return `
      <td><span class="score-badge analytical">${r.analytical_score}/16</span></td>
      <td><span class="score-badge verbal">${r.verbal_score}/16</span></td>
      <td><span class="score-badge quantitative">${r.quantitative_score}/16</span></td>`;
  };

  tbody.innerHTML = rows.length
    ? rows.map((r, i) => `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="result-checkbox" data-id="${r.submission_id}" ${selectedResultIds.has(r.submission_id) ? 'checked' : ''} onchange="toggleResultSelection(${r.submission_id}, this)"></td>` : ''}
          <td class="text-center"><span class="serial-badge">${i + 1}</span></td>
          <td class="td-left"><b>${escapeHtml(r.full_name)}</b><div class="text-xs text-slate-500 mt-1">CID: ${escapeHtml(r.cid_number || '-')}</div></td>
          <td><span class="score-badge total">${r.score}/${totalQ || r.total_questions}</span></td>
          ${sectionScoreCols(r)}
          <td><span class="rank-badge">${r.rank}</span></td>
          <td>${escapeHtml(r.contact_number || '-')}</td>
          <td><button class="btn-icon btn-soft" title="View answer sheet" onclick="viewParticipantResult(${r.submission_id})">${ICON.eye}</button></td>
          ${isSuperAdmin() ? `<td><button class="btn-icon btn-danger" title="Delete" onclick="deleteResult(${r.submission_id})">${ICON.trash}</button></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${colSpan}" class="text-center text-slate-500 py-8">No results yet.</td></tr>`;
}

function toggleResultSelection(id, el) {
  if (el.checked) selectedResultIds.add(id); else selectedResultIds.delete(id);
  syncResultsDeleteBtn();
}

function toggleSelectAllResults(el) {
  document.querySelectorAll('.result-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedResultIds.add(id); else selectedResultIds.delete(id);
  });
  syncResultsDeleteBtn();
}

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
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadDashboard(false);
}

async function deleteSelectedResults() {
  if (!selectedResultIds.size) return;
  const count = selectedResultIds.size;
  const ok = await showConfirm(`Delete ${count} result(s)?`, 'Delete Selected', 'Delete');
  if (!ok) return;
  try {
    await Promise.all([...selectedResultIds].map(id => api(`/api/admin/results/${id}`, { method: 'DELETE' })));
    selectedResultIds.clear();
    syncResultsDeleteBtn();
    await showSuccess(`${count} result(s) deleted.`, 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadDashboard(false);
}

/* ── Result detail modal ───────────────────────────────────── */

async function viewParticipantResult(submissionId) {
  try {
    const data = await api(`/api/admin/results/${submissionId}/detail`);
    showResultDetailModal(data);
  } catch (err) { showError(err.message, 'Could Not Load Result'); }
}

function showResultDetailModal(d) {
  currentResultDetail = d;
  document.getElementById('resultDetailOverlay')?.remove();

  const opts = (a) => ({ A: a.option_a, B: a.option_b, C: a.option_c, D: a.option_d, E: a.option_e });
  const answersHtml = (d.answers || []).map((a, i) => {
    const o   = opts(a);
    const sel = a.selected_option || '';
    const selText  = sel && o[sel] ? `${sel}. ${escapeHtml(o[sel])}` : (sel || '—');
    const corrText = a.correct_option && o[a.correct_option] ? `${a.correct_option}. ${escapeHtml(o[a.correct_option])}` : (a.correct_option || '—');
    const rowCls   = a.is_correct ? 'rd-row-correct' : (sel ? 'rd-row-wrong' : '');
    const statusBadge = a.is_correct
      ? `<span class="rd-status correct">✓</span>`
      : (sel ? `<span class="rd-status wrong">✗</span>` : `<span class="rd-status skip">—</span>`);
    const imgHtml = a.image_url ? `<img src="${escapeHtml(toDirectImageUrl(a.image_url))}" alt="" style="max-height:60px;border-radius:4px;margin-top:4px;display:block" onerror="this.style.display='none'">` : '';
    return `
      <tr class="${rowCls}">
        <td class="rd-qnum">${i + 1}</td>
        <td><span class="pill pill-teal" style="font-size:.72rem;padding:.28rem .55rem">${escapeHtml(a.section || '-')}</span></td>
        <td class="rd-qtext">${escapeHtml(a.question_text)}${imgHtml}</td>
        <td class="rd-ans ${a.is_correct ? 'correct' : (sel ? 'wrong' : '')}">${selText}</td>
        <td class="rd-ans correct">${corrText}</td>
        <td class="text-center">${statusBadge}</td>
      </tr>`;
  }).join('');

  // Build dynamic section score cards
  const sectionScoreCards = (() => {
    const pct = Number(d.percentage || 0).toFixed(1);
    const totalQ = d.total_questions || allSections.reduce((s, sec) => s + sec.questions_per_test, 0);
    let cards = `<div class="rd-score-item total"><span>Total</span><b>${d.score}${totalQ ? `/${totalQ}` : ''}</b></div>`;
    if (d.section_scores && d.section_scores.length) {
      d.section_scores.forEach(ss => {
        const [, , , accent] = sectionPalette(ss.section_name);
        cards += `<div class="rd-score-item"><span>${escapeHtml(ss.section_name)}</span><b style="color:${accent}">${ss.score}/${ss.questions_count}</b></div>`;
      });
    } else {
      cards += `<div class="rd-score-item analytical"><span>Analytical</span><b>${d.analytical_score}/16</b></div>`;
      cards += `<div class="rd-score-item verbal"><span>Verbal</span><b>${d.verbal_score}/16</b></div>`;
      cards += `<div class="rd-score-item quantitative"><span>Quantitative</span><b>${d.quantitative_score}/16</b></div>`;
    }
    cards += `<div class="rd-score-item pct"><span>Score %</span><b>${pct}%</b></div>`;
    cards += `<div class="rd-score-item rank"><span>Rank</span><b>#${d.rank}</b></div>`;
    return cards;
  })();

  const noAnswers = !d.answers || d.answers.length === 0
    ? `<tr><td colspan="6" class="text-center text-slate-500 py-8">No per-question data available.</td></tr>`
    : answersHtml;

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
      <div class="rd-scores">${sectionScoreCards}</div>
      <div class="rd-table-wrap">
        <table class="rd-table">
          <thead><tr><th>#</th><th>Section</th><th>Question</th><th>Your Answer</th><th>Correct Answer</th><th>Result</th></tr></thead>
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
  const opts = (a) => ({ A: a.option_a, B: a.option_b, C: a.option_c, D: a.option_d, E: a.option_e });
  // All participant/question data is HTML-escaped before being written to the popup
  // via win.document.write(). Without escaping, a question saved with an HTML payload
  // (e.g. <script>…</script>) would execute in the admin-origin print window.
  const rows = (d.answers || []).map((a, i) => {
    const o        = opts(a);
    const sel      = a.selected_option || '';
    const selText  = sel && o[sel] ? `${sel}. ${escapeHtml(o[sel])}` : (escapeHtml(sel) || '—');
    const corrText = a.correct_option && o[a.correct_option]
      ? `${a.correct_option}. ${escapeHtml(o[a.correct_option])}`
      : (escapeHtml(a.correct_option) || '—');
    const rowCls   = a.is_correct ? 'correct-row' : (sel ? 'wrong-row' : '');
    const status   = a.is_correct ? '<span class="status-c">&#10003; Correct</span>'
      : (sel ? '<span class="status-w">&#10007; Wrong</span>' : '<span class="status-s">&#8212; Skipped</span>');
    return `<tr class="${rowCls}">
      <td style="text-align:center;color:#94a3b8;font-weight:900">${i + 1}</td>
      <td>${escapeHtml(a.section || '—')}</td>
      <td>${escapeHtml(a.question_text)}</td>
      <td class="${a.is_correct ? 'ans-c' : (sel ? 'ans-w' : '')}">${selText}</td>
      <td class="ans-c">${corrText}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  const pct = Number(d.percentage || 0).toFixed(1);
  const submittedAt = d.submitted_at ? formatDate(d.submitted_at) : '—';
  const totalQ = d.total_questions || allSections.reduce((s, sec) => s + sec.questions_per_test, 0);

  const scoreHtml = (() => {
    let h = `<div class="si total"><span class="lbl">Total Score</span><span class="val">${d.score}${totalQ ? `/${totalQ}` : ''}</span></div>`;
    if (d.section_scores && d.section_scores.length) {
      d.section_scores.forEach(ss => {
        h += `<div class="si"><span class="lbl">${escapeHtml(ss.section_name)}</span><span class="val">${ss.score}/${ss.questions_count}</span></div>`;
      });
    } else {
      h += `<div class="si ana"><span class="lbl">Analytical</span><span class="val">${d.analytical_score}/16</span></div>`;
      h += `<div class="si ver"><span class="lbl">Verbal</span><span class="val">${d.verbal_score}/16</span></div>`;
      h += `<div class="si qnt"><span class="lbl">Quantitative</span><span class="val">${d.quantitative_score}/16</span></div>`;
    }
    h += `<div class="si pct"><span class="lbl">Score %</span><span class="val">${pct}%</span></div>`;
    h += `<div class="si rnk"><span class="lbl">Rank</span><span class="val">#${d.rank}</span></div>`;
    return h;
  })();

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <title>Result &#8212; ${escapeHtml(d.full_name)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Helvetica,Arial,sans-serif;color:#0f172a;padding:28px;font-size:13px}
    .header{border-bottom:2px solid #e2e8f0;padding-bottom:14px;margin-bottom:14px}
    .org{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#2563eb;margin-bottom:6px}
    .name{font-size:20px;font-weight:900}.sub{color:#64748b;font-size:11.5px;margin-top:5px}
    .scores{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding:12px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0}
    .si{text-align:center;min-width:82px}.si .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.055em;color:#64748b;display:block;margin-bottom:3px}
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
  </style></head><body>
  <div class="header">
    <div class="org">Digital Aptitude Evaluation System &#8212; Individual Result</div>
    <div class="name">${escapeHtml(d.full_name)}</div>
    <div class="sub">CID: ${escapeHtml(d.cid_number || '&#8212;')} &nbsp;&middot;&nbsp; ${escapeHtml(d.company_name || '&#8212;')} &nbsp;&middot;&nbsp; ${escapeHtml(d.contact_number || '&#8212;')}</div>
  </div>
  <div class="scores">${scoreHtml}</div>
  <table>
    <thead><tr><th>#</th><th>Section</th><th>Question</th><th>Your Answer</th><th>Correct Answer</th><th>Result</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:16px;color:#64748b">No per-question data available.</td></tr>'}</tbody>
  </table>
  <div class="footer"><span>Submitted: ${submittedAt}</span><span>DAES — Confidential</span></div>
  <script>window.onload=()=>{window.print()}<\/script>
  </body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showError('Could not open print window. Please allow pop-ups for this site.', 'Popup Blocked'); return; }
  win.document.write(html);
  win.document.close();
}

/* ── Print All Results ─────────────────────────────────────── */

function printAllResults() {
  const results = [...allResults].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  if (!results.length) { showError('No results to print yet.', 'No Results'); return; }
  const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const topScore  = results[0]?.score ?? '—';
  const avgScore  = results.length
    ? (results.reduce((s, r) => s + (r.score || 0), 0) / results.length).toFixed(1)
    : '—';
  const totalQ = allSections.reduce((s, sec) => s + sec.questions_per_test, 0);

  const sectionHeaders = allSections.length
    ? allSections.map(s => `<th class="c">${escapeHtml(s.label || s.name)}<br>/${s.questions_per_test}</th>`).join('')
    : '';

  const rows = results.map((r, i) => {
    const denom  = totalQ || r.total_questions || 1;
    const pct    = ((r.score / denom) * 100).toFixed(1);
    const pctN   = parseFloat(pct);
    const scoreCol = pctN >= 70 ? '#15803d' : pctN >= 50 ? '#1d4ed8' : '#b91c1c';
    const secCols = (() => {
      const scoreByName = {};
      (r.section_scores || []).forEach(ss => { scoreByName[ss.section_name] = ss; });
      const hasNew = r.section_scores && r.section_scores.length > 0;
      if (allSections.length) {
        return allSections.map(sec => {
          if (hasNew) {
            const ss = scoreByName[sec.name];
            return `<td class="c">${ss ? ss.score : 0}/${ss ? ss.questions_count : sec.questions_per_test}</td>`;
          }
          if (sec.name === 'Analytical Ability')  return `<td class="c">${r.analytical_score}/16</td>`;
          if (sec.name === 'Verbal Ability')       return `<td class="c">${r.verbal_score}/16</td>`;
          if (sec.name === 'Quantitative Skills')  return `<td class="c">${r.quantitative_score}/16</td>`;
          return `<td class="c">—</td>`;
        }).join('');
      }
      return '';
    })();
    return `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td class="c serial">${i + 1}</td>
      <td class="name-cell"><b>${escapeHtml(r.full_name)}</b><br><span class="cid">${escapeHtml(r.cid_number || '—')}</span></td>
      <td>${escapeHtml(r.contact_number || '—')}</td>
      <td class="c stotal" style="color:${scoreCol}">${r.score}/${totalQ || r.total_questions}</td>
      ${secCols}
      <td class="c pct" style="color:${scoreCol}">${pct}%</td>
    </tr>`;
  }).join('');

  const colCount = 4 + allSections.length;
  const sectionNames = allSections.map(s => s.label || s.name).join(' / ');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>DAES — All Results</title>
<style>
  @page{size:A4 landscape;margin:32mm 12mm 24mm}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#0f172a}
  .pg-header{position:fixed;top:0;left:0;right:0;height:30mm;background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 58%,#0f766e 100%);display:flex;align-items:center;justify-content:space-between;padding:0 14mm;border-bottom:3px solid #2dd4bf}
  .pg-header .hl .org-name{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#2dd4bf;margin-bottom:4px}
  .pg-header .hl .test-title{font-size:18px;font-weight:900;color:#fff;line-height:1}
  .pg-header .hr{text-align:right}.pg-header .hr .lbl{font-size:8px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.09em;display:block;margin-bottom:3px}
  .pg-header .hr .val{font-size:10.5px;color:rgba(255,255,255,.85);font-weight:700}
  .pg-footer{position:fixed;bottom:0;left:0;right:0;height:22mm;border-top:1.5px solid #e2e8f0;background:#f8fafc;display:flex;align-items:center;justify-content:space-between;padding:0 14mm}
  .pg-footer .fc{font-size:8.5px;color:#475569;font-weight:700}.pg-footer .fr{font-size:8px;color:#94a3b8;text-align:right}
  .intro{margin-bottom:14px;padding-bottom:12px;border-bottom:2px solid #e2e8f0;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .intro-left .doc-title{font-size:14px;font-weight:900;margin-bottom:3px}.intro-left .doc-sub{font-size:9.5px;color:#64748b;line-height:1.5}
  .intro-stats{display:flex;gap:1px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;flex-shrink:0}
  .istat{text-align:center;padding:8px 16px;background:#f8fafc;border-right:1px solid #e2e8f0}.istat:last-child{border-right:none}
  .istat .lbl{font-size:7.5px;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;display:block;margin-bottom:3px}
  .istat .val{font-size:16px;font-weight:900;color:#1e3a8a}
  table{width:100%;border-collapse:collapse;font-size:10.5px}thead{display:table-header-group}
  thead tr{background:#1e3a8a}
  th{padding:7px 8px;text-align:left;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#fff;white-space:nowrap;border:none}
  th.c{text-align:center}
  .tbl-caption{background:#0f172a;padding:8px 10px 7px;border-bottom:2px solid #2dd4bf;text-align:left}
  .tbl-caption-title{display:block;font-size:10px;font-weight:900;color:#fff;margin-bottom:2px}
  .tbl-caption-sub{display:block;font-size:7.5px;font-weight:600;color:rgba(255,255,255,.5)}
  td{padding:5px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
  tr.even td{background:#fff}tr.odd td{background:#f8fafc}.c{text-align:center}
  .serial{color:#94a3b8;font-weight:700}.name-cell b{font-size:11px;font-weight:800}.name-cell .cid{font-size:8.5px;color:#94a3b8}
  .stotal{font-weight:900;font-size:12px}.pct{font-weight:800}
</style></head><body>
  <div class="pg-header">
    <div class="hl"><div class="org-name">DHI Group of Company</div><div class="test-title">HiPo Aptitude Test</div></div>
    <div class="hr"><span class="lbl">Date Printed</span><span class="val">${printDate}</span></div>
  </div>
  <div class="pg-footer">
    <span class="fc">Confidential &mdash; For Internal Use Only &nbsp;&middot;&nbsp; DHI Group of Company</span>
    <span class="fr">HiPo Aptitude Test &nbsp;&middot;&nbsp; ${printDate}</span>
  </div>
  <div class="intro">
    <div class="intro-left">
      <div class="doc-title">Final Result Summary &mdash; All Participants</div>
      <div class="doc-sub">Sections: ${sectionNames}<br>${totalQ} Questions &nbsp;&middot;&nbsp; 1 Mark Per Question &nbsp;&middot;&nbsp; No Negative Marking &nbsp;&middot;&nbsp; Ranked by Total Score</div>
    </div>
    <div class="intro-stats">
      <div class="istat"><span class="lbl">Participants</span><span class="val">${results.length}</span></div>
      <div class="istat"><span class="lbl">Max Score</span><span class="val">${totalQ}</span></div>
      <div class="istat"><span class="lbl">Top Score</span><span class="val">${topScore}</span></div>
      <div class="istat"><span class="lbl">Avg Score</span><span class="val">${avgScore}</span></div>
    </div>
  </div>
  <table>
    <thead>
      <tr><th colspan="${colCount}" class="tbl-caption"><span class="tbl-caption-title">Participant Results — Ranked by Total Score</span><span class="tbl-caption-sub">${totalQ} Questions &nbsp;·&nbsp; Sections: ${sectionNames} &nbsp;·&nbsp; 1 Mark Each &nbsp;·&nbsp; No Negative Marking</span></th></tr>
      <tr><th class="c">SL No.</th><th>Name &amp; CID</th><th>Contact</th><th class="c">Total<br>/${totalQ}</th>${sectionHeaders}<th class="c">Score %</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <script>window.onload=()=>{window.print()}<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showError('Could not open print window. Please allow pop-ups for this site.', 'Popup Blocked'); return; }
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
            <td><div class="flex gap-2">
              <button class="btn-icon btn-small" title="Copy" onclick="copyPasscode('${escapeHtml(p.code)}')">${ICON.copy}</button>
              <button class="btn-icon btn-danger" title="Delete" onclick="deletePasscode(${p.id})">${ICON.trash}</button>
            </div></td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="text-center text-slate-500 py-8">No passcodes generated yet.</td></tr>`;
}

async function loadPasscodes() {
  if (!document.getElementById('passcodesTable')) return;
  try { allPasscodes = await api('/api/admin/passcodes'); renderPasscodes(allPasscodes); }
  catch (err) { showError(err.message, 'Could Not Load Passcodes'); }
}

async function generatePasscode() {
  try {
    const data    = await api('/api/admin/passcodes/generate', { method: 'POST' });
    const box     = document.getElementById('generatedPasscode');
    const helpBox = document.getElementById('passcodeHelpBox');
    if (helpBox) helpBox.classList.add('hidden');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = `<div class="generated-code-card"><span>New participant passcode</span>
        <code class="passcode-code">${escapeHtml(data.code)}</code>
        <button class="btn-small" onclick="copyPasscode('${escapeHtml(data.code)}')">Copy Code</button></div>`;
    }
    await loadPasscodes();
    await showSuccess(`${data.message || 'Passcode generated.'} Code: ${data.code}`, 'Generated');
  } catch (err) { showError(err.message, 'Generation Failed'); }
}

async function deletePasscode(id) {
  const ok = await showConfirm('Delete this passcode permanently?', 'Delete Passcode', 'Delete');
  if (!ok) return;
  try { await api(`/api/admin/passcodes/${id}`, { method: 'DELETE' }); await showSuccess('Passcode deleted.', 'Deleted'); loadPasscodes(); }
  catch (err) { showError(err.message, 'Delete Failed'); }
}

async function copyPasscode(code) {
  try {
    await navigator.clipboard.writeText(code);
    await showSuccess(`Copied: ${code}`, 'Copied');
  } catch {
    showModal({ title: 'Copy Manually', message: `Clipboard access denied. Copy this passcode manually:<br><br><code class="passcode-code">${escapeHtml(code)}</code>`, type: 'info', confirmText: 'Done', allowHtml: true });
  }
}

/* ── Questions ─────────────────────────────────────────────── */

function renderQuestions(rows) {
  const tbody = document.getElementById('questionsTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllQuestions');
  if (selectAll) selectAll.checked = false;

  // Rebuild bank summary now that questions are known.
  renderBankSummary();

  const useSections = allSections.length
    ? allSections
    : [
        { name: 'Analytical Ability',  label: 'Section A · Analytical Ability',  sort_order: 1 },
        { name: 'Verbal Ability',      label: 'Section B · Verbal Ability',       sort_order: 2 },
        { name: 'Quantitative Skills', label: 'Section C · Quantitative Skills',  sort_order: 3 },
      ];

  const cols = isSuperAdmin() ? 6 : 4;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center text-slate-500 py-8">No questions found.</td></tr>`;
    return;
  }

  // Collect all section names (from DB sections + any unknown sections in question data).
  const knownNames = new Set(useSections.map(s => s.name));
  const extraSections = [...new Set(rows.filter(q => !knownNames.has(q.section)).map(q => q.section))]
    .map(name => ({ name, label: name, sort_order: 999 }));
  const allSec = [...useSections, ...extraSections];

  const chevronSvg = `<svg class="q-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"/></svg>`;

  let html = '';
  let num  = 1;
  allSec.forEach(sec => {
    const qs = rows.filter(q => q.section === sec.name);
    if (!qs.length) return;
    const qPerTest = allSections.find(s => s.name === sec.name)?.questions_per_test ?? '?';
    html += `<tr class="q-section-header">
      <td colspan="${cols}">${escapeHtml(sec.label || sec.name)}
        <span>&nbsp;—&nbsp; ${qs.length} question${qs.length !== 1 ? 's' : ''} in bank &nbsp;·&nbsp; ${qPerTest} randomly shown per participant</span>
      </td>
    </tr>`;
    qs.forEach(q => {
      const n           = num++;
      const isFillBlank = q.question_type === 'fill_blank';
      const qAnswer     = allAnswers.find(a => Number(a.question_id) === Number(q.id));
      const hasAnswer   = qAnswer && qAnswer.id > 0 && qAnswer.correct_option;

      // Section label: e.g. "Section B · Verbal Ability" → "Section B"
      const sectionShort = sec.label ? sec.label.split('·')[0].trim() : sec.name;

      // Type badge: MCQ (blue) or Fill (purple)
      const typePill = isFillBlank
        ? `<span class="pill" style="background:#ede9fe;color:#6d28d9;border-color:#ddd6fe;font-size:.63rem">Fill</span>`
        : `<span class="pill" style="background:#dbeafe;color:#1d4ed8;border-color:#bfdbfe;font-size:.63rem">MCQ</span>`;

      // Expanded options / answer panel shown on chevron click
      const optsPanel = isFillBlank
        ? `<div class="q-bank-opts hidden" id="qopts_${q.id}">
             <div class="q-bank-opt-item" style="font-style:italic;color:#475569">
               <span class="q-bank-opt-badge" style="background:#e0f2fe;color:#0369a1;border-color:#bae6fd">Ans</span>
               ${hasAnswer ? escapeHtml(qAnswer.correct_option) : '<span style="color:#94a3b8">Not set</span>'}
             </div>
           </div>`
        : `<div class="q-bank-opts hidden" id="qopts_${q.id}">
             <div class="q-bank-opt-item"><span class="q-bank-opt-badge">A</span>${escapeHtml(q.option_a)}</div>
             <div class="q-bank-opt-item"><span class="q-bank-opt-badge">B</span>${escapeHtml(q.option_b)}</div>
             <div class="q-bank-opt-item"><span class="q-bank-opt-badge">C</span>${escapeHtml(q.option_c)}</div>
             <div class="q-bank-opt-item"><span class="q-bank-opt-badge">D</span>${escapeHtml(q.option_d)}</div>
             ${q.option_e ? `<div class="q-bank-opt-item"><span class="q-bank-opt-badge">E</span>${escapeHtml(q.option_e)}</div>` : ''}
           </div>`;

      // Warn when no answer has been configured yet
      const noAnswerHint = !hasAnswer
        ? `<span style="display:inline-block;margin-top:4px;font-size:.68rem;font-weight:700;color:#f59e0b">&#9888; No answer set</span>`
        : '';

      html += `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center"><input type="checkbox" class="question-checkbox" data-id="${q.id}"
              ${selectedQuestionIds.has(q.id) ? 'checked' : ''} onchange="toggleQuestionSelection(${q.id}, this)"></td>` : ''}
          <td style="vertical-align:top;padding-top:10px"><span class="pill">${n}</span></td>
          <td style="vertical-align:top;padding-top:8px">
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
              <span class="pill pill-teal" style="font-size:.63rem;text-transform:uppercase;letter-spacing:.05em;padding:.22rem .55rem">${escapeHtml(sectionShort)}</span>
              ${typePill}
            </div>
          </td>
          <td>
            <div style="font-weight:700;color:#1e293b;line-height:1.55;cursor:pointer;" onclick="toggleQOptions(${q.id})">${escapeHtml(q.question_text)}</div>
            ${noAnswerHint}
            ${optsPanel}
          </td>
          <td class="text-center" style="vertical-align:top;padding-top:10px">${q.image_url
            ? `<img src="${escapeHtml(toDirectImageUrl(q.image_url))}" alt="img" style="max-height:40px;max-width:68px;border-radius:6px;object-fit:contain;cursor:pointer;border:1px solid #e2e8f0" onclick="window.open('${escapeHtml(toDirectImageUrl(q.image_url))}','_blank')">`
            : '<span style="color:#cbd5e1;font-size:0.8rem">—</span>'}</td>
          ${isSuperAdmin() ? `<td style="vertical-align:top;padding-top:8px"><div class="flex gap-1.5 items-center">
            <button class="btn-icon" id="qchevron_${q.id}" title="Show options" onclick="toggleQOptions(${q.id})">${chevronSvg}</button>
            <button class="btn-icon btn-warning" title="Edit"   onclick="editQuestion(${q.id})">${ICON.edit}</button>
            <button class="btn-icon btn-danger"  title="Delete" onclick="deleteQuestion(${q.id})">${ICON.trash}</button>
          </div></td>` : ''}
        </tr>`;
    });
  });
  tbody.innerHTML = html;
}

function toggleQOptions(id) {
  const panel   = document.getElementById(`qopts_${id}`);
  const chevron = document.querySelector(`#qchevron_${id} .q-chevron`);
  if (!panel) return;
  const nowHidden = panel.classList.toggle('hidden');
  if (chevron) chevron.classList.toggle('open', !nowHidden);
}

function toggleQuestionSelection(id, el) {
  if (el.checked) selectedQuestionIds.add(id); else selectedQuestionIds.delete(id);
  syncQuestionsDeleteBtn();
}

function toggleSelectAllQuestions(el) {
  document.querySelectorAll('.question-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedQuestionIds.add(id); else selectedQuestionIds.delete(id);
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
  const ok = await showConfirm(`Delete ${count} question(s)?`, 'Delete Selected', 'Delete');
  if (!ok) return;
  try {
    await Promise.all([...selectedQuestionIds].map(id => api(`/api/admin/questions/${id}`, { method: 'DELETE' })));
    selectedQuestionIds.clear(); syncQuestionsDeleteBtn();
    await showSuccess(`${count} question(s) deleted.`, 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadQuestionsAdmin();
}

// Fetches both questions and answers in a single parallel request pair and
// re-renders whichever table is present on the current page. Use this instead
// of calling loadQuestionsAdmin() + loadAnswersAdmin() back-to-back to avoid
// issuing 4 requests and a potential race on the shared allAnswers cache.
async function loadQuestionsAndAnswers() {
  const hasQ = !!document.getElementById('questionsTable');
  const hasA = !!document.getElementById('answersTable');
  if (!hasQ && !hasA) return;
  try {
    [allQuestions, allAnswers] = await Promise.all([
      api('/api/admin/questions').then(r => r || []),
      api('/api/admin/answers').then(r => r || []),
    ]);
    if (hasQ) renderQuestions(allQuestions);
    if (hasA) renderAnswers(allAnswers);
  } catch (err) { showError(err.message, 'Could Not Load Data'); }
}

async function loadQuestionsAdmin() {
  if (!document.getElementById('questionsTable')) return;
  try {
    [allQuestions, allAnswers] = await Promise.all([
      api('/api/admin/questions').then(r => r || []),
      api('/api/admin/answers').then(r => r || []).catch(() => allAnswers),
    ]);
    renderQuestions(allQuestions);
  }
  catch (err) { showError(err.message, 'Could Not Load Questions'); }
}

document.getElementById('questionSearch')?.addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  renderQuestions(allQuestions.filter(q =>
    `${q.id} ${q.section} ${q.question_text} ${q.option_a} ${q.option_b} ${q.option_c} ${q.option_d} ${q.option_e}`.toLowerCase().includes(term)
  ));
});

/* ── Question image helpers ────────────────────────────────── */

function previewQuestionImage(input) {
  const file = input.files[0];
  const wrap = document.getElementById('imagePreviewWrap');
  const img  = document.getElementById('imagePreview');
  const name = document.getElementById('imageFileName');
  if (!file) { if (wrap) wrap.classList.add('hidden'); return; }
  name.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    img.src = e.target.result;
    wrap.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  document.getElementById('removeImageBtn')?.classList.remove('hidden');
}

async function removeQuestionImage() {
  const id = document.getElementById('question_id_edit').value;
  if (id) {
    try { await api(`/api/admin/questions/${id}/image`, { method: 'DELETE' }); }
    catch { /* ignore */ }
  }
  document.getElementById('question_image_url').value = '';
  document.getElementById('questionImageFile').value  = '';
  document.getElementById('imagePreviewWrap')?.classList.add('hidden');
  document.getElementById('imageFileName').textContent = '';
  document.getElementById('removeImageBtn')?.classList.add('hidden');
}

function highlightCorrectOpt() {
  const radios = document.querySelectorAll('input[name="correct_option_inline"]');
  radios.forEach(r => {
    const lbl = r.closest('.correct-opt-btn');
    if (!lbl) return;
    lbl.classList.toggle('active', r.checked);
    const check = lbl.querySelector('.opt-check');
    if (check) check.classList.toggle('hidden', !r.checked || r.value === '');
  });
}

function onQuestionTypeChange() {
  const type = document.querySelector('input[name="question_type_radio"]:checked')?.value || 'mcq';
  document.getElementById('question_type').value = type;
  const isFill = type === 'fill_blank';
  document.getElementById('mcqOptionsBlock')?.classList.toggle('hidden', isFill);
  document.getElementById('mcqCorrectBlock')?.classList.toggle('hidden', isFill);
  document.getElementById('fillBlankCorrectBlock')?.classList.toggle('hidden', !isFill);
  // Update type toggle button styles
  document.getElementById('qt_mcq_lbl')?.classList.toggle('active', !isFill);
  document.getElementById('qt_fill_lbl')?.classList.toggle('active', isFill);
}

function editQuestion(id) {
  const q = allQuestions.find(q => Number(q.id) === Number(id));
  if (!q) return;
  document.getElementById('question_id_edit').value  = q.id;
  document.getElementById('question_section').value  = q.section;
  document.getElementById('question_text').value     = q.question_text;
  document.getElementById('option_a').value = q.option_a || '';
  document.getElementById('option_b').value = q.option_b || '';
  document.getElementById('option_c').value = q.option_c || '';
  document.getElementById('option_d').value = q.option_d || '';
  document.getElementById('option_e').value = q.option_e || '';
  document.getElementById('question_image_url').value = q.image_url || '';
  // Restore question type.
  const qType = q.question_type || 'mcq';
  document.querySelectorAll('input[name="question_type_radio"]').forEach(r => {
    r.checked = r.value === qType;
  });
  onQuestionTypeChange();
  // Populate correct answer from allAnswers if available.
  const existingAnswer = allAnswers.find(a => Number(a.question_id) === Number(id));
  const correctOpt = existingAnswer?.correct_option || '';
  if (qType === 'fill_blank') {
    const fbInput = document.getElementById('fill_blank_answer');
    if (fbInput) fbInput.value = correctOpt;
  } else {
    document.querySelectorAll('input[name="correct_option_inline"]').forEach(r => {
      r.checked = r.value === correctOpt;
    });
    highlightCorrectOpt();
  }
  // Show existing image if present.
  const wrap = document.getElementById('imagePreviewWrap');
  const img  = document.getElementById('imagePreview');
  if (q.image_url && wrap && img) {
    img.src = toDirectImageUrl(q.image_url);
    wrap.classList.remove('hidden');
    document.getElementById('removeImageBtn')?.classList.remove('hidden');
  } else if (wrap) {
    wrap.classList.add('hidden');
    document.getElementById('removeImageBtn')?.classList.add('hidden');
  }
  document.getElementById('imageFileName').textContent = q.image_url ? 'Existing image' : '';
  document.getElementById('questionFormTitle').textContent = `Edit Question #${q.id}`;
  document.getElementById('questionSubmitBtn').querySelector('span').textContent = 'Update Question';
  document.getElementById('cancelQuestionEdit').classList.remove('hidden');
  document.getElementById('saveAndAddAnotherBtn')?.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetQuestionForm(keepSection = false) {
  const section = keepSection ? document.getElementById('question_section')?.value : null;
  document.getElementById('questionForm')?.reset();
  document.getElementById('question_id_edit').value    = '';
  document.getElementById('question_image_url').value  = '';
  document.getElementById('imagePreviewWrap')?.classList.add('hidden');
  document.getElementById('imageFileName').textContent = '';
  document.getElementById('removeImageBtn')?.classList.add('hidden');
  // Restore section selection.
  const sel = document.getElementById('question_section');
  if (sel) {
    if (keepSection && section) sel.value = section;
    else if (allSections.length) sel.value = allSections[0].name;
  }
  // Reset question type to MCQ.
  const mcqRadio = document.querySelector('input[name="question_type_radio"][value="mcq"]');
  if (mcqRadio) { mcqRadio.checked = true; onQuestionTypeChange(); }
  // Reset correct answer to "not set".
  document.querySelectorAll('input[name="correct_option_inline"]').forEach(r => {
    r.checked = r.value === '';
  });
  highlightCorrectOpt();
  const fbInput = document.getElementById('fill_blank_answer');
  if (fbInput) fbInput.value = '';
  document.getElementById('questionFormTitle').textContent = 'Add Question';
  document.getElementById('questionSubmitBtn').querySelector('span').textContent = 'Save Question';
  document.getElementById('cancelQuestionEdit').classList.add('hidden');
  document.getElementById('saveAndAddAnotherBtn')?.classList.remove('hidden');
  pendingSaveMode = 'save';
}

document.getElementById('questionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = pendingSaveMode;
  pendingSaveMode = 'save';
  const id      = document.getElementById('question_id_edit').value;
  const qType   = document.getElementById('question_type')?.value || 'mcq';
  const isFill  = qType === 'fill_blank';
  const payload = {
    section:       document.getElementById('question_section').value,
    question_text: document.getElementById('question_text').value,
    question_type: qType,
    option_a:      isFill ? '' : (document.getElementById('option_a').value || ''),
    option_b:      isFill ? '' : (document.getElementById('option_b').value || ''),
    option_c:      isFill ? '' : (document.getElementById('option_c').value || ''),
    option_d:      isFill ? '' : (document.getElementById('option_d').value || ''),
    option_e:      isFill ? '' : (document.getElementById('option_e').value || ''),
    image_url:     document.getElementById('question_image_url').value || '',
  };
  const correctOpt = isFill
    ? (document.getElementById('fill_blank_answer')?.value.trim() || '')
    : (document.querySelector('input[name="correct_option_inline"]:checked')?.value || '');
  try {
    const result = await api(id ? `/api/admin/questions/${id}` : '/api/admin/questions', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    const newQId = id || result?.id;
    // Upload image if a new file was selected.
    const imageFile = document.getElementById('questionImageFile')?.files[0];
    if (newQId && imageFile) {
      const fd = new FormData();
      fd.append('image', imageFile);
      try {
        await fetch(`/api/admin/questions/${newQId}/image`, { method: 'POST', body: fd, credentials: 'include' });
      } catch { /* non-fatal */ }
    }
    // Save correct answer inline if chosen.
    if (newQId && correctOpt) {
      // GetAnswers returns id=0 via COALESCE for questions with no answer row yet.
      // We must use POST (not PUT /0) when the answer row doesn't exist yet.
      const existingAns = allAnswers.find(
        a => Number(a.question_id) === Number(newQId) && a.id > 0
      );
      try {
        await api(existingAns ? `/api/admin/answers/${existingAns.id}` : '/api/admin/answers', {
          method: existingAns ? 'PUT' : 'POST',
          body: JSON.stringify({ question_id: Number(newQId), correct_option: correctOpt }),
        });
      } catch { /* non-fatal — answer can be set from Answers page */ }
    }
    if (mode === 'add_another') {
      resetQuestionForm(true); // keep section
      await loadQuestionsAndAnswers();
      const msg = document.getElementById('message');
      if (msg) {
        msg.textContent = `✓ Question ${newQId} saved${correctOpt ? ' (Answer: ' + correctOpt + ')' : ''}. Add the next one.`;
        msg.className = 'message success';
        setTimeout(() => { msg.textContent = ''; msg.className = ''; }, 4000);
      }
    } else {
      await showSuccess(id ? 'Question updated.' : `Question #${newQId} saved${correctOpt ? ' (correct: ' + correctOpt + ')' : ''}.`, 'Saved');
      resetQuestionForm();
      loadQuestionsAndAnswers();
    }
  } catch (err) { showError(err.message, 'Save Failed'); }
});

async function deleteQuestion(id) {
  const ok = await showConfirm('Delete this question? Its linked answer will also be removed.', 'Delete Question', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/questions/${id}`, { method: 'DELETE' });
    selectedQuestionIds.delete(id); syncQuestionsDeleteBtn();
    await showSuccess('Question deleted.', 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
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
  } catch (err) { showError(err.message, 'Upload Failed'); }
}

/* ── Bulk image upload ─────────────────────────────────────── */

let _bulkImageInput = null;

function onBulkImageSelect(input) {
  _bulkImageInput = input;
  const count = input.files.length;
  const preview = document.getElementById('bulkImagePreview');
  const countEl = document.getElementById('bulkImageCount');
  const btn     = document.getElementById('bulkImageUploadBtn');
  const results = document.getElementById('bulkImageResults');
  if (count > 0) {
    countEl.textContent = count;
    preview.classList.remove('hidden');
    btn.classList.remove('hidden');
    results.classList.add('hidden');
    document.getElementById('bulkImageUrlList').value = '';
  } else {
    preview.classList.add('hidden');
    btn.classList.add('hidden');
  }
}

async function uploadBulkImages() {
  if (!_bulkImageInput || _bulkImageInput.files.length === 0) return;
  const fd = new FormData();
  for (const f of _bulkImageInput.files) fd.append('images', f);
  const btn = document.getElementById('bulkImageUploadBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const res  = await fetch('/api/admin/questions/images/bulk', { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
    const uploaded = data.uploaded || [];
    const urls   = uploaded.filter(r => r.url).map(r => r.url);
    const errors = uploaded.filter(r => r.error);
    const textarea = document.getElementById('bulkImageUrlList');
    const baseUrl  = window.location.origin;
    textarea.value = urls.map(u => baseUrl + u).join('\n');
    document.getElementById('bulkImageResults').classList.remove('hidden');
    if (errors.length > 0) {
      const names = errors.map(e => `${e.filename}: ${e.error}`).join('\n');
      showError(`${urls.length} uploaded, ${errors.length} failed:\n${names}`, 'Partial Upload');
    } else {
      await showSuccess(`${urls.length} image(s) uploaded successfully.`, 'Done');
    }
  } catch (err) {
    showError(err.message, 'Upload Failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload Images`;
  }
}

function copyBulkImageUrls() {
  const ta = document.getElementById('bulkImageUrlList');
  if (!ta || !ta.value) return;
  navigator.clipboard.writeText(ta.value).then(() => showSuccess('URLs copied to clipboard.', 'Copied'));
}

/* ── Answers ───────────────────────────────────────────────── */

function renderAnswers(rows) {
  const tbody = document.getElementById('answersTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllAnswers');
  if (selectAll) selectAll.checked = false;
  tbody.innerHTML = rows.length
    ? rows.map(a => {
        const hasAnswer = a.correct_option && a.correct_option !== '';
        const isMCQOpt  = hasAnswer && /^[A-Da-d]$/.test(a.correct_option.trim());
        const optionBadge = hasAnswer
          ? (isMCQOpt
              ? `<span class="pill pill-green">Option ${escapeHtml(a.correct_option.toUpperCase())}</span>`
              : `<span class="pill" style="background:#ede9fe;color:#5b21b6;border-color:#ddd6fe" title="Fill-in-the-blank answer">${escapeHtml(a.correct_option)}</span>`)
          : `<span class="pill" style="background:#fef3c7;color:#92400e;border-color:#fde68a">Not Set</span>`;
        const actionCell = isSuperAdmin() ? `<td><div class="flex gap-2">
            ${hasAnswer
              ? `<button class="btn-icon btn-warning" title="Edit"   onclick="editAnswer(${a.id})">${ICON.edit}</button>
                 <button class="btn-icon btn-danger"  title="Delete" onclick="deleteAnswer(${a.id})">${ICON.trash}</button>`
              : ''
            }
          </div></td>` : '';
        return `
        <tr>
          ${isSuperAdmin() ? `<td class="text-center">${hasAnswer ? `<input type="checkbox" class="answer-checkbox" data-id="${a.id}" ${selectedAnswerIds.has(a.id) ? 'checked' : ''} onchange="toggleAnswerSelection(${a.id}, this)">` : ''}</td>` : ''}
          <td>${a.question_id}</td>
          <td><span class="pill pill-teal">${escapeHtml(a.section || '-')}</span></td>
          <td class="min-w-[300px]">${escapeHtml(a.question_text)}</td>
          <td>${optionBadge}</td>
          ${actionCell}
        </tr>`;
      }).join('')
    : `<tr><td colspan="${isSuperAdmin() ? 6 : 4}" class="text-center text-slate-500 py-8">No questions found.</td></tr>`;
}


function toggleAnswerSelection(id, el) {
  if (el.checked) selectedAnswerIds.add(id); else selectedAnswerIds.delete(id);
  syncAnswersDeleteBtn();
}

function toggleSelectAllAnswers(el) {
  document.querySelectorAll('.answer-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedAnswerIds.add(id); else selectedAnswerIds.delete(id);
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
  const ok = await showConfirm(`Delete ${count} answer(s)?`, 'Delete Selected', 'Delete');
  if (!ok) return;
  try {
    await Promise.all([...selectedAnswerIds].map(id => api(`/api/admin/answers/${id}`, { method: 'DELETE' })));
    selectedAnswerIds.clear(); syncAnswersDeleteBtn();
    await showSuccess(`${count} answer(s) deleted.`, 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadAnswersAdmin();
}

async function loadAnswersAdmin() {
  if (!document.getElementById('answersTable')) return;
  try {
    [allAnswers, allQuestions] = await Promise.all([
      api('/api/admin/answers').then(r => r || []),
      api('/api/admin/questions').then(r => r || []).catch(() => allQuestions),
    ]);
    renderAnswers(allAnswers);
  }
  catch (err) { showError(err.message, 'Could Not Load Answers'); }
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
  const q      = allQuestions.find(q => Number(q.id) === Number(a.question_id));
  const isFill = q?.question_type === 'fill_blank';

  document.getElementById('editAnswerModalId').value  = a.id;
  document.getElementById('editAnswerModalQId').value = a.question_id;
  document.getElementById('editAnswerModalTitle').textContent    = `Edit Answer #${a.id}`;
  document.getElementById('editAnswerModalQuestion').textContent = a.question_text || '';
  document.getElementById('editAnswerModalLabel').textContent    = isFill ? 'Accepted Keywords' : 'Correct Option';

  const sel  = document.getElementById('editAnswerModalSelect');
  const txt  = document.getElementById('editAnswerModalText');
  const hint = document.getElementById('editAnswerModalHint');
  sel.classList.toggle('hidden', isFill);
  txt.classList.toggle('hidden', !isFill);
  hint.classList.toggle('hidden', !isFill);

  if (isFill) { txt.value = a.correct_option; }
  else        { sel.value = a.correct_option; }

  document.getElementById('editAnswerModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  setTimeout(() => (isFill ? txt : sel).focus(), 50);
}

function closeEditAnswerModal() {
  document.getElementById('editAnswerModal')?.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function submitEditAnswerModal() {
  const id    = document.getElementById('editAnswerModalId').value;
  const qId   = Number(document.getElementById('editAnswerModalQId').value);
  const isFill = allQuestions.find(q => Number(q.id) === qId)?.question_type === 'fill_blank';
  const correct = isFill
    ? (document.getElementById('editAnswerModalText')?.value?.trim() || '')
    : (document.getElementById('editAnswerModalSelect')?.value || '');
  if (!correct) return showError('Please enter a correct answer.', 'Required');
  try {
    await api(`/api/admin/answers/${id}`, {
      method: 'PUT', body: JSON.stringify({ question_id: qId, correct_option: correct }),
    });
    closeEditAnswerModal();
    await showSuccess('Answer updated.', 'Saved');
    loadAnswersAdmin();
  } catch (err) { showError(err.message, 'Save Failed'); }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('editAnswerModal');
  if (modal && !modal.classList.contains('hidden')) closeEditAnswerModal();
});

async function deleteAnswer(id) {
  const ok = await showConfirm('Delete this answer record?', 'Delete Answer', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/answers/${id}`, { method: 'DELETE' });
    selectedAnswerIds.delete(id); syncAnswersDeleteBtn();
    await showSuccess('Answer deleted.', 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadAnswersAdmin();
}

/* ── Participants ───────────────────────────────────────────── */

function renderParticipants(rows) {
  const tbody = document.getElementById('participantsTable');
  if (!tbody) return;
  const selectAll = document.getElementById('selectAllParticipants');
  if (selectAll) selectAll.checked = false;
  const extra = isSuperAdmin() ? 2 : 0;
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
  try { allParticipants = await api('/api/admin/participants'); renderParticipants(allParticipants); }
  catch (err) { showError(err.message, 'Could Not Load Participants'); }
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
  } catch (err) { showError(err.message, 'Add Failed'); }
});

async function deleteParticipant(id, name, hasSubmitted) {
  const msg = hasSubmitted
    ? `Delete "${name}"? They have already submitted — their test result will also be deleted.`
    : `Delete "${name}"? They will no longer be able to access the test.`;
  const ok = await showConfirm(msg, 'Delete Participant', 'Delete');
  if (!ok) return;
  try {
    await api(`/api/admin/participants/${id}`, { method: 'DELETE' });
    selectedParticipantIds.delete(id); syncParticipantsDeleteBtn();
    await showSuccess('Participant deleted.', 'Deleted');
    loadParticipantsAdmin();
  } catch (err) { showError(err.message, 'Delete Failed'); }
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
  } catch (err) { showError(err.message, 'Upload Failed'); }
}

function toggleParticipantSelection(id, el) {
  if (el.checked) selectedParticipantIds.add(id); else selectedParticipantIds.delete(id);
  syncParticipantsDeleteBtn();
}

function toggleSelectAllParticipants(el) {
  document.querySelectorAll('.participant-checkbox').forEach(cb => {
    cb.checked = el.checked;
    const id = Number(cb.dataset.id);
    if (el.checked) selectedParticipantIds.add(id); else selectedParticipantIds.delete(id);
  });
  syncParticipantsDeleteBtn();
}

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
  const ok = await showConfirm(`Delete ${count} participant(s)?`, 'Delete Selected', 'Delete');
  if (!ok) return;
  try {
    await Promise.all([...selectedParticipantIds].map(id => api(`/api/admin/participants/${id}`, { method: 'DELETE' })));
    selectedParticipantIds.clear(); syncParticipantsDeleteBtn();
    await showSuccess(`${count} participant(s) deleted.`, 'Deleted');
  } catch (err) { showError(err.message, 'Delete Failed'); }
  loadParticipantsAdmin();
}

/* ── Admin users ───────────────────────────────────────────── */

function renderAdminUsers(rows) {
  const tbody = document.getElementById('adminsTable');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" class="text-center text-slate-500 py-8">No admin users found.</td></tr>`; return; }
  const sorted = [...rows.filter(a => a.id === currentAdmin.id), ...rows.filter(a => a.id !== currentAdmin.id)];
  tbody.innerHTML = sorted.map((a, idx) => {
    const isSelf      = a.id === currentAdmin.id;
    const uJson     = JSON.stringify(a.username);
    const roleEditBtn = isSelf ? '' :
      `<button class="btn-icon btn-soft" title="Change Role" onclick="changeAdminRole(${a.id}, '${a.role}', ${uJson})">${ICON.shield}</button>`;
    return `
      <tr>
        <td><span class="pill">${idx + 1}</span></td>
        <td><b>${escapeHtml(a.username)}</b>${isSelf ? '<br><span class="text-xs text-slate-400 font-semibold">(you)</span>' : ''}</td>
        <td><span class="pill ${a.role === 'super_admin' ? 'pill-teal' : ''}">${a.role === 'super_admin' ? 'Super Admin' : 'General Admin'}</span></td>
        <td><span class="status-pill ${a.is_active ? 'active' : 'expired'}">${a.is_active ? 'Active' : 'Revoked'}</span></td>
        <td><div class="flex gap-2 flex-wrap">
          ${roleEditBtn}
          <button class="btn-icon btn-warning" title="Change Password" onclick="changeAdminPassword(${a.id}, ${uJson})">${ICON.key}</button>
          <button class="btn-icon ${a.is_active ? 'btn-danger' : 'btn-small'}" title="${a.is_active ? 'Revoke' : 'Activate'}" onclick="setAdminAccess(${a.id}, ${!a.is_active})">${a.is_active ? ICON.lock : ICON.unlock}</button>
          ${isSelf ? '' : `<button class="btn-icon btn-danger" title="Delete" onclick="deleteAdminUser(${a.id}, ${uJson})">${ICON.trash}</button>`}
        </div></td>
      </tr>`;
  }).join('');
}

async function loadAdminUsers() {
  if (!document.getElementById('adminsTable')) return;
  try { const rows = await api('/api/admin/users'); renderAdminUsers(rows); }
  catch (err) { showError(err.message, 'Could Not Load Admins'); }
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
  } catch (err) { showError(err.message, 'Create Failed'); }
});

async function setAdminAccess(id, active) {
  const ok = await showConfirm(active ? 'Activate this admin account?' : 'Revoke access for this admin account?', 'Confirm', active ? 'Activate' : 'Revoke');
  if (!ok) return;
  try { await api(`/api/admin/users/${id}/access`, { method: 'PUT', body: JSON.stringify({ is_active: active }) }); await showSuccess('Admin access updated.', 'Updated'); loadAdminUsers(); }
  catch (err) { showError(err.message, 'Update Failed'); }
}

async function changeAdminPassword(id, username) {
  const password = await showPasswordModal(`Set new password for ${username}`);
  if (!password) return;
  try { await api(`/api/admin/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }); await showSuccess('Password changed. The admin must log in again.', 'Changed'); loadAdminUsers(); }
  catch (err) { showError(err.message, 'Password Change Failed'); }
}

async function changeAdminRole(id, currentRole, username) {
  const newRole = await showRoleModal(username, currentRole);
  if (!newRole || newRole === currentRole) return;
  const label = newRole === 'super_admin' ? 'Super Admin' : 'General Admin';
  const ok = await showConfirm(`Change role for "${username}" to ${label}?`, 'Change Role', 'Confirm');
  if (!ok) return;
  try { await api(`/api/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) }); await showSuccess(`Role updated to ${label}.`, 'Role Updated'); loadAdminUsers(); }
  catch (err) { showError(err.message, 'Role Change Failed'); }
}

function showRoleModal(username, currentRole) {
  return new Promise((resolve) => {
    const modal = ensureAppModal();
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
    confirmBtn.textContent = 'Update Role'; cancelBtn.textContent = 'Cancel';
    cancelBtn.classList.remove('hidden'); modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    const close = (val) => { modal.classList.add('hidden'); document.body.classList.remove('modal-open'); confirmBtn.onclick = null; cancelBtn.onclick = null; resolve(val); };
    confirmBtn.onclick = () => close(document.getElementById('modalRoleSelect').value);
    cancelBtn.onclick  = () => close('');
    setTimeout(() => document.getElementById('modalRoleSelect')?.focus(), 50);
  });
}

async function deleteAdminUser(id, username) {
  const ok = await showConfirm(`Permanently delete admin "${username}"?`, 'Delete Admin', 'Delete');
  if (!ok) return;
  try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); await showSuccess('Admin deleted.', 'Deleted'); loadAdminUsers(); }
  catch (err) { showError(err.message, 'Delete Failed'); }
}

function showPasswordModal(title) {
  return new Promise((resolve) => {
    const modal = ensureAppModal();
    const confirmBtn = document.getElementById('appModalConfirm');
    const cancelBtn  = document.getElementById('appModalCancel');
    document.getElementById('appModalIcon').className   = 'app-modal-icon info';
    document.getElementById('appModalIcon').textContent = '🔐';
    document.getElementById('appModalTitle').textContent = title;
    document.getElementById('appModalBody').innerHTML = `<input id="modalPasswordInput" type="password" class="input" placeholder="New password (min 6 characters)" minlength="6">`;
    confirmBtn.textContent = 'Change Password'; cancelBtn.textContent = 'Cancel';
    cancelBtn.classList.remove('hidden'); modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    const close = (val) => { modal.classList.add('hidden'); document.body.classList.remove('modal-open'); confirmBtn.onclick = null; cancelBtn.onclick = null; resolve(val); };
    confirmBtn.onclick = () => { const val = document.getElementById('modalPasswordInput').value.trim(); if (val.length >= 6) close(val); };
    cancelBtn.onclick  = () => close('');
    setTimeout(() => document.getElementById('modalPasswordInput')?.focus(), 50);
  });
}

/* ── Initialisation ────────────────────────────────────────── */

async function initAdminPages() {
  await loadCurrentAdmin();
  const page = location.pathname.split('/').pop();
  if (!isSuperAdmin() && (page === 'passcodes.html' || page === 'admins.html' || page === 'test-settings.html')) return;

  // Load sections first — other loaders depend on it for dynamic column rendering.
  await loadSections();

  loadDashboard();
  startDashboardAutoRefresh();
  loadPasscodes();
  if (document.getElementById('passcodesTable')) setInterval(loadPasscodes, 15000);
  loadQuestionsAndAnswers();
  loadParticipantsAdmin();
  loadAdminUsers();
  loadTestConfigForm();
}

initAdminPages();
