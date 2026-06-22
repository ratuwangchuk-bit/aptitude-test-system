let questions           = [];
let submitted           = false;
let testStarted         = false; // true only after /api/start-test succeeds
let currentQuestionIdx  = 0;
let timerInterval       = null; // the countdown tick() interval — cleared on submit so it doesn't keep running on the post-submit screen
const selectedAnswers   = {}; // { [question_id]: 'A'|'B'|'C'|'D' }

// These are set dynamically from /api/test-info before the test starts.
let DURATION     = 60 * 60; // fallback — overwritten by initTest()
let testSections = [];       // [{id, name, label, questions_per_test, sort_order}]

// ── Single-tab enforcement ─────────────────────────────────────────────────────
const _tabChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('daes_test_tab')
  : null;
let _isActiveTab = false;

_tabChannel?.addEventListener('message', e => {
  if (e.data.type === 'check' && _isActiveTab) {
    _tabChannel.postMessage({ type: 'active' });
  }
});

function acquireTabLock() {
  if (!_tabChannel) return Promise.resolve(true);
  return new Promise(resolve => {
    let denied = false;
    const onReply = e => {
      if (e.data.type === 'active') {
        denied = true;
        _tabChannel.removeEventListener('message', onReply);
        resolve(false);
      }
    };
    _tabChannel.addEventListener('message', onReply);
    _tabChannel.postMessage({ type: 'check' });
    setTimeout(() => {
      _tabChannel.removeEventListener('message', onReply);
      if (!denied) { _isActiveTab = true; resolve(true); }
    }, 150);
  });
}

/* ── Section helpers ────────────────────────────────────────────────────────── */

function getSectionMeta(sectionName) {
  const meta = testSections.find(s => s.name === sectionName);
  return {
    label:  meta?.label  || sectionName,
    letter: meta?.label  ? meta.label.replace('Section ', '').trim() : sectionName.slice(0, 3),
    qpt:    meta?.questions_per_test || 0,
  };
}

// Returns sections that have at least one question in the current question set.
function activeSectionsInOrder() {
  const fromMeta = testSections
    .filter(s => questions.some(q => q.section === s.name))
    .map(s => s.name);
  // Include any sections present in questions but not in testSections (e.g. uploaded questions).
  questions.forEach(q => {
    if (!fromMeta.includes(q.section)) fromMeta.push(q.section);
  });
  return fromMeta;
}

/* ── Progress tracking ─────────────────────────────────────────────────────── */

function updateAnsweredProgress() {
  const answered = questions.filter(q => selectedAnswers[q.id]).length;
  const total    = questions.length;

  const answeredEl  = document.getElementById('answeredCount');
  const progressBar = document.getElementById('progressBar');
  const submitBtn   = document.getElementById('submitBtn');

  if (answeredEl)  answeredEl.textContent = `${answered}/${total}`;
  if (progressBar) progressBar.style.width = total ? `${(answered / total) * 100}%` : '0%';

  if (submitBtn) {
    const allAnswered = total > 0 && answered === total;
    submitBtn.disabled = !allAnswered;
    submitBtn.classList.toggle('opacity-40',         !allAnswered);
    submitBtn.classList.toggle('cursor-not-allowed', !allAnswered);
  }

  updateSidebarButtons();
  updateSectionTabs();
}

/* ── Sidebar + section tab bar ─────────────────────────────────────────────── */

function buildSidebarAndTabs() {
  const sidebar = document.getElementById('testSidebar');
  const tabBar  = document.getElementById('testSectionBar');
  if (!sidebar || !tabBar) return;

  const sections = activeSectionsInOrder();
  let globalIdx  = 0;
  let tabsHtml   = '';
  let sideHtml   = '';

  sections.forEach(sectionName => {
    const sq   = questions.filter(q => q.section === sectionName);
    if (!sq.length) return;
    const meta = getSectionMeta(sectionName);

    const tabLabel = meta.label && meta.label !== sectionName
      ? `${escapeHtml(meta.label)}<span class="tab-section-name">${escapeHtml(sectionName)}</span>`
      : escapeHtml(sectionName);
    tabsHtml += `
      <button class="tab-btn" data-tab-section="${escapeHtml(sectionName)}"
              onclick="jumpToSection(this.dataset.tabSection)">
        ${tabLabel}
        <span class="tab-score" data-tab-score="${escapeHtml(sectionName)}">0/${sq.length}</span>
      </button>`;

    sideHtml += `
      <div class="sb-section-header">
        <span class="sb-dot"></span>${escapeHtml(meta.label)}
      </div>
      <div class="sb-grid">`;
    sq.forEach((q, li) => {
      sideHtml += `<button class="sb-q" id="sbq_${globalIdx}" onclick="goToQuestion(${globalIdx})">${li + 1}</button>`;
      globalIdx++;
    });
    sideHtml += '</div>';
  });

  tabBar.innerHTML  = tabsHtml;
  sidebar.innerHTML = sideHtml;
}

function updateSidebarButtons() {
  questions.forEach((q, gi) => {
    const btn = document.getElementById(`sbq_${gi}`);
    if (!btn) return;
    const isCurrent  = gi === currentQuestionIdx;
    const isAnswered = Boolean(selectedAnswers[q.id]);
    btn.className = 'sb-q' + (isCurrent ? ' sq-current' : isAnswered ? ' sq-answered' : '');
  });
}

function updateSectionTabs() {
  const activeSection = questions[currentQuestionIdx]?.section;
  activeSectionsInOrder().forEach(sectionName => {
    const sq     = questions.filter(q => q.section === sectionName);
    const done   = sq.filter(q => selectedAnswers[q.id]).length;

    const scoreEl = document.querySelector(`[data-tab-score="${CSS.escape(sectionName)}"]`);
    if (scoreEl) scoreEl.textContent = `${done}/${sq.length}`;

    const tabEl = document.querySelector(`[data-tab-section="${CSS.escape(sectionName)}"]`);
    if (tabEl) tabEl.classList.toggle('tab-active', sectionName === activeSection);
  });
}

/* ── Markdown table renderer ───────────────────────────────────────────────── */

function renderQuestionText(raw) {
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].includes('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows  = tableLines.map(l =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
      );
      const isSep = r => r.every(c => /^[-:\s]+$/.test(c));
      const sepIdx = rows.findIndex(isSep);

      const headerRows = sepIdx > 0 ? rows.slice(0, sepIdx) : [];
      const dataRows   = sepIdx >= 0 ? rows.slice(sepIdx + 1) : rows;

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

/* ── Question display ──────────────────────────────────────────────────────── */

function showQuestion(idx) {
  if (idx < 0 || idx >= questions.length) return;
  currentQuestionIdx = idx;

  const q      = questions[idx];
  const meta   = getSectionMeta(q.section || '');
  const sectionQs = questions.filter(sq => sq.section === q.section);
  const localIdx  = sectionQs.indexOf(q);
  const saved     = selectedAnswers[q.id] || '';

  const form = document.getElementById('testForm');
  if (!form) return;

  form.innerHTML = `
    <button class="q-section-badge" data-section="${escapeHtml(q.section)}"
            onclick="jumpToSection(this.dataset.section)" title="Click to switch to this section">
      <span class="q-badge-dot"></span>
      ${meta.label && meta.label !== q.section
        ? `${escapeHtml(meta.label)}<span style="opacity:.65;font-weight:700;letter-spacing:.05em;text-transform:none;font-size:.95em">: ${escapeHtml(q.section)}</span>`
        : escapeHtml(q.section)}
    </button>
    <p class="q-meta">
      <span>Question ${localIdx + 1} of ${sectionQs.length}</span>
      <span class="sep">|</span>
      <span>Overall ${idx + 1} of ${questions.length}</span>
    </p>
    <div class="q-text-card">${renderQuestionText(q.question_text)}</div>
    ${q.image_url ? `<div class="q-img-wrap"><img src="${escapeHtml(toDirectImageUrl(q.image_url))}" alt="Question image" class="q-img" onerror="this.closest('.q-img-wrap').style.display='none'"></div>` : ''}
    ${(q.question_type === 'fill_blank' || (!q.option_a && !q.option_b && !q.option_c && !q.option_d))
      ? `<div class="q-fill-wrap">
           <label class="block text-sm font-semibold mb-2" style="color:rgba(255,255,255,.5)">Your Answer</label>
           <input id="qfill_${q.id}" type="text" class="q-fill-input"
                  placeholder="Type your answer here…"
                  value="${escapeHtml(saved)}"
                  oninput="onFillChange(${q.id}, this.value)"
                  autocomplete="off">
         </div>`
      : `<div class="q-options">
           ${['A','B','C','D','E'].filter(opt => q['option_' + opt.toLowerCase()]).map(opt => {
             const text   = (q['option_' + opt.toLowerCase()] || '').trim();
             const selCls = saved === opt ? ' q-selected' : '';
             return `
               <label class="q-opt${selCls}" id="qopt_${q.id}_${opt}"
                      onclick="onOptionChange(${q.id},'${opt}')">
                 <span class="q-opt-badge">${opt}</span>
                 <span>${escapeHtml(text)}</span>
               </label>`;
           }).join('')}
         </div>`
    }
    <div class="q-nav">
      <button class="q-nav-btn" onclick="goToQuestion(${idx - 1})" ${idx === 0 ? 'disabled' : ''}>
        &#8592; Previous
      </button>
      <button class="q-nav-btn q-next" onclick="goToQuestion(${idx + 1})"
              ${idx === questions.length - 1 ? 'disabled' : ''}>
        Next &#8594;
      </button>
    </div>`;

  document.querySelector('.test-q-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
  updateSidebarButtons();
  updateSectionTabs();
}

function onOptionChange(qId, opt) {
  selectedAnswers[qId] = opt;
  ['A','B','C','D','E'].forEach(o => {
    document.getElementById(`qopt_${qId}_${o}`)?.classList.remove('q-selected');
  });
  document.getElementById(`qopt_${qId}_${opt}`)?.classList.add('q-selected');
  updateAnsweredProgress();
}

function onFillChange(qId, value) {
  const trimmed = value.trim();
  if (trimmed) {
    selectedAnswers[qId] = value; // store raw (server trims on scoring)
  } else {
    delete selectedAnswers[qId];
  }
  updateAnsweredProgress();
}

function goToQuestion(idx) {
  if (idx < 0 || idx >= questions.length) return;
  showQuestion(idx);
  closeMobileSidebar(); // no-op on desktop widths
}

function jumpToSection(section) {
  const idx = questions.findIndex(q => q.section === section);
  if (idx !== -1) goToQuestion(idx);
}

/* ── Mobile sidebar drawer ─────────────────────────────────────────────────── */

function toggleMobileSidebar() {
  document.getElementById('testSidebar')?.classList.toggle('sidebar-open');
  document.getElementById('sidebarBackdrop')?.classList.toggle('show');
}

function closeMobileSidebar() {
  document.getElementById('testSidebar')?.classList.remove('sidebar-open');
  document.getElementById('sidebarBackdrop')?.classList.remove('show');
}

/* ── Question loading ──────────────────────────────────────────────────────── */

async function loadQuestions(savedAnswers = null) {
  try {
    const participantId = Number(localStorage.getItem('participant_id'));
    questions = (await api(`/api/questions?participant_id=${participantId}`)) || [];
    const form = document.getElementById('testForm');

    if (!questions.length) {
      form.innerHTML = `
        <div class="card p-8 text-center">
          <h2 class="text-xl font-black">No questions available</h2>
          <p class="text-slate-500 mt-2">Please contact the administrator.</p>
        </div>`;
      return;
    }

    buildSidebarAndTabs();

    if (savedAnswers) {
      savedAnswers.forEach(a => {
        if (a.selected_option) selectedAnswers[a.question_id] = a.selected_option;
      });
    }

    updateAnsweredProgress();
    showQuestion(0);
  } catch (err) {
    setMessage('message', err.message, true);
  }
}

/* ── Mid-test availability watchers ───────────────────────────────────────── */
// Both the passcode and the participant's assigned section set can be
// invalidated by an admin while a participant is already mid-exam (passcode
// expiry/deletion, or disabling a section as a kill switch). Either case ends
// the test immediately: show a banner and auto-submit, rather than waiting
// for the participant's next page load to discover it.

function showAutoSubmitBanner(message) {
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position:fixed','top:0','left:0','right:0','z-index:99999',
    'background:#7f1d1d','border-bottom:2px solid #ef4444',
    'color:#fca5a5','font-weight:800','font-size:0.9rem',
    'padding:0.9rem 1.5rem','text-align:center',
  ].join(';');
  banner.textContent = message;
  document.body.prepend(banner);
  setTimeout(() => submitTest(true), 3000);
}

// Polls checkValid() every 30s; the first time it resolves false, shows the
// banner and auto-submits.
function startAvailabilityWatcher(checkValid, message) {
  const interval = setInterval(async () => {
    if (submitted) { clearInterval(interval); return; }
    try {
      if (!(await checkValid())) {
        clearInterval(interval);
        showAutoSubmitBanner(message);
      }
    } catch { /* Network error — wait for next tick. */ }
  }, 30000);
}

function startPasscodeWatcher() {
  const passcodeId = Number(localStorage.getItem('passcode_id'));
  if (!passcodeId) return;
  startAvailabilityWatcher(async () => {
    const res  = await fetch(`/api/passcode-status/${passcodeId}`);
    const data = await res.json().catch(() => ({}));
    return !!data.valid;
  }, '⚠  The session passcode has expired. Your answers are being submitted automatically…');
}

function startSectionAvailabilityWatcher() {
  const participantId = Number(localStorage.getItem('participant_id'));
  if (!participantId) return;
  startAvailabilityWatcher(async () => {
    const res  = await fetch(`/api/test-availability?participant_id=${participantId}`);
    const data = await res.json().catch(() => ({}));
    return !!data.available;
  }, '⚠  This test has been disabled by the administrator. Your answers are being submitted automatically…');
}

/* ── 5-minute warning toast ────────────────────────────────────────────────── */

function showTimerWarning() {
  // Play a soft beep using the Web Audio API (no external file needed).
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    [0, 180, 360].forEach(delay => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type      = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.4, ctx.currentTime + delay / 1000);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay / 1000 + 0.4);
      osc.start(ctx.currentTime + delay / 1000);
      osc.stop(ctx.currentTime  + delay / 1000 + 0.4);
    });
  } catch { /* Audio not supported — skip beep. */ }

  // Show a non-blocking banner that auto-dismisses after 8 seconds.
  const banner = document.createElement('div');
  banner.id = 'timerWarningBanner';
  banner.style.cssText = [
    'position:fixed', 'top:72px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:99999', 'background:#7f1d1d', 'color:#fca5a5',
    'border:1.5px solid #ef4444', 'border-radius:12px',
    'padding:0.85rem 1.4rem', 'font-weight:800', 'font-size:0.92rem',
    'display:flex', 'align-items:center', 'gap:0.6rem',
    'box-shadow:0 8px 32px rgba(0,0,0,0.45)',
    'animation:slideDown 0.35s ease',
  ].join(';');
  banner.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span>Only <b>5 minutes</b> remaining — please review and submit your answers.</span>
    <button onclick="this.parentElement.remove()" style="margin-left:0.6rem;background:transparent;
      border:none;color:#fca5a5;cursor:pointer;font-size:1.1rem;line-height:1;padding:0"
      aria-label="Dismiss">&#10005;</button>`;

  // Inject keyframe if not already present.
  if (!document.getElementById('_timerWarnStyle')) {
    const s = document.createElement('style');
    s.id = '_timerWarnStyle';
    s.textContent = `@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`;
    document.head.appendChild(s);
  }

  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 8000);
}

// playTick plays a short sharp click sound — used for the 10-second countdown.
let _tickCtx = null;
function playTick(isLast) {
  try {
    if (!_tickCtx) _tickCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx  = _tickCtx;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Higher pitch on the final tick (0s).
    osc.type = 'square';
    osc.frequency.value = isLast ? 1200 : 900;
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.08);
  } catch { /* Audio not supported — skip. */ }
}

// showCountdownBanner shows (or updates) the 10-second fixed banner.
function showCountdownBanner(remaining) {
  let banner = document.getElementById('countdownBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'countdownBanner';
    banner.style.cssText = [
      'position:fixed', 'top:72px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:100000', 'background:#450a0a', 'color:#fca5a5',
      'border:2px solid #dc2626', 'border-radius:12px',
      'padding:0.8rem 1.6rem', 'font-weight:900', 'font-size:1.05rem',
      'display:flex', 'align-items:center', 'gap:0.7rem',
      'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
      'animation:slideDown 0.25s ease',
    ].join(';');
    banner.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;animation:pulse 1s infinite">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span id="countdownBannerText"></span>`;
    document.body.appendChild(banner);
  }
  const n = remaining;
  document.getElementById('countdownBannerText').innerHTML =
    n > 0
      ? `Submitting in <b style="font-size:1.3em;color:#f87171">${n}</b> second${n === 1 ? '' : 's'}!`
      : `<b style="color:#f87171">Time\'s up! Submitting…</b>`;
}

/* ── Timer ─────────────────────────────────────────────────────────────────── */

function startTimer() {
  const stored   = localStorage.getItem('test_start_time');
  const storedMs = stored ? parseInt(stored, 10) : NaN;
  // Use strict > so a start-time that is exactly DURATION old is treated as expired
  // (remaining = 0), not stale (which would reset the clock to a full DURATION).
  const isStale  = !stored || isNaN(storedMs) || (Date.now() - storedMs) > DURATION * 1000;
  if (isStale) localStorage.setItem('test_start_time', Date.now().toString());

  const startTime = parseInt(localStorage.getItem('test_start_time'), 10);
  let fiveMinWarningShown = false;
  let countdownStarted    = false;

  function tick() {
    const elapsed   = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, DURATION - elapsed);
    const minutes   = Math.floor(remaining / 60);
    const seconds   = remaining % 60;
    const timer     = document.getElementById('timer');
    if (timer) {
      timer.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
      if (remaining <= 300) timer.parentElement.classList.add('animate-pulse');
    }
    if (!fiveMinWarningShown && remaining <= 300 && remaining > 0) {
      fiveMinWarningShown = true;
      showTimerWarning();
    }
    // 10-second countdown: show banner and play a tick every second.
    if (remaining <= 10 && remaining > 0) {
      countdownStarted = true;
      showCountdownBanner(remaining);
      playTick(false);
    }
    if (remaining <= 0) {
      if (countdownStarted) {
        showCountdownBanner(0);
        playTick(true);
      }
      clearInterval(timerInterval);
      submitTest(true);
    }
  }

  tick();
  timerInterval = setInterval(tick, 1000);
}

/* ── Submission ────────────────────────────────────────────────────────────── */

async function submitTest(auto = false) {
  if (submitted) return;
  if (!auto) {
    const ok = await showConfirm(
      'Submit your test now? You cannot change answers after submission.',
      'Submit Test', 'Submit'
    );
    if (!ok) return;
  }
  submitted = true;
  clearInterval(timerInterval); // stop the countdown tick — a manual/early submit doesn't go through tick()'s own clearInterval

  const participantId = Number(localStorage.getItem('participant_id'));
  const answers = questions.map(q => ({
    question_id:     q.id,
    selected_option: selectedAnswers[q.id] || '',
  }));

  try {
    await api('/api/submit-test', {
      method: 'POST',
      body:   JSON.stringify({ participant_id: participantId, answers }),
    });

    _isActiveTab = false;
    localStorage.removeItem('participant_id');
    localStorage.removeItem('test_start_time');
    localStorage.removeItem('passcode_id');

    document.body.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6"
           style="background:#0f172a">
        <div class="glass-card p-8 max-w-lg text-center">
          <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
          <h1 class="text-3xl font-black text-green-700 mt-5">Thank You for Participating</h1>
          <p class="text-slate-600 mt-3 leading-relaxed">Your answers have been submitted successfully. Please wait for good news from the administrator.</p>
          <div class="rounded-2xl bg-green-50 border border-green-100 p-4 mt-6 text-green-800 font-bold">
            Your result will be reviewed and announced by the administrator.
          </div>
          <a href="index.html" class="btn inline-flex mt-6">Back to Home</a>
        </div>
      </div>`;
  } catch (err) {
    // 409 means the beacon already submitted on a prior refresh/close — treat
    // it as a success so the participant sees the thank-you screen.
    if (err.message && err.message.toLowerCase().includes('already submitted')) {
      _isActiveTab = false;
      localStorage.removeItem('participant_id');
      localStorage.removeItem('test_start_time');
      localStorage.removeItem('passcode_id');
      document.body.innerHTML = `
        <div class="min-h-screen flex items-center justify-center p-6"
             style="background:#0f172a">
          <div class="glass-card p-8 max-w-lg text-center">
            <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
            <h1 class="text-3xl font-black text-green-700 mt-5">Thank You for Participating</h1>
            <p class="text-slate-600 mt-3 leading-relaxed">Your answers have been submitted successfully. Please wait for good news from the administrator.</p>
            <div class="rounded-2xl bg-green-50 border border-green-100 p-4 mt-6 text-green-800 font-bold">
              Your result will be reviewed and announced by the administrator.
            </div>
            <a href="index.html" class="btn inline-flex mt-6">Back to Home</a>
          </div>
        </div>`;
      return;
    }
    submitted = false;
    setMessage('message', err.message, true);
  }
}

document.getElementById('submitBtn')?.addEventListener('click', () => submitTest(false));

document.addEventListener('copy',        e => { e.preventDefault(); });
document.addEventListener('contextmenu', e => { e.preventDefault(); });

/* ── Beacon auto-submit ─────────────────────────────────────────────────────── */

function autoSubmitViaBeacon() {
  const participantId = Number(localStorage.getItem('participant_id'));
  if (!participantId || questions.length === 0) return;

  const answers = questions.map(q => ({
    question_id:     q.id,
    selected_option: selectedAnswers[q.id] || '',
  }));

  sessionStorage.setItem('_testSession', JSON.stringify({ participantId, answers }));

  const payload = JSON.stringify({ participant_id: participantId, answers });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/submit-test', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch('/api/submit-test', {
      method: 'POST', body: payload,
      headers: { 'Content-Type': 'application/json' }, keepalive: true,
    });
  }
}

async function cancelAutoSubmit(participantId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 400));
    try {
      const res  = await fetch('/api/cancel-submission', {
        method:      'DELETE',
        body:        JSON.stringify({ participant_id: participantId }),
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (data.cancelled) return true;
    } catch { /* Network error — retry. */ }
  }
  return false;
}

window.addEventListener('beforeunload', e => {
  if (!submitted) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('pagehide', () => {
  // Fire beacon whenever questions are loaded — covers both normal close and
  // page refresh. The questions.length guard prevents beaconing a blank
  // submission if the page is closed before questions finish loading.
  if (!submitted && questions.length > 0) autoSubmitViaBeacon();
});

/* ── Entry point ───────────────────────────────────────────────────────────── */

async function initTest() {
  const participantId = localStorage.getItem('participant_id');
  if (!participantId) { window.location.href = 'index.html'; return; }

  // Reload recovery.
  const navType    = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const sessionRaw = sessionStorage.getItem('_testSession');
  let savedAnswersForRestore = null;

  // On reload the beacon fired on pagehide — don't cancel it.
  // Answers in sessionStorage are kept only as a temporary fallback in the rare
  // race where submission-status returns false before the beacon is processed.
  if (navType === 'reload' && sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw);
      if (session.participantId === Number(participantId)) {
        savedAnswersForRestore = session.answers;
      }
    } catch { /* Malformed checkpoint — ignore. */ }
    sessionStorage.removeItem('_testSession');
  }

  // Block if already submitted.
  try {
    const status = await api(`/api/submission-status/${participantId}`);
    if (status.submitted) {
      // Clear all three keys so the participant cannot skip the passcode gate on a
      // subsequent visit (passcode_id is missing here in the original code — bug fix).
      localStorage.removeItem('participant_id');
      localStorage.removeItem('test_start_time');
      localStorage.removeItem('passcode_id');
      document.getElementById('testForm').innerHTML = `
        <div class="card p-8 text-center">
          <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
          <h2 class="text-2xl font-black text-red-600 mt-4">Test Already Submitted</h2>
          <p class="text-slate-500 mt-3 leading-relaxed">You have already completed this test. Please wait for the administrator to announce results.</p>
          <a href="index.html" class="btn inline-flex mt-6">Back to Home</a>
        </div>`;
      document.getElementById('submitBtn')?.setAttribute('disabled', 'true');
      submitted = true;
      return;
    }
  } catch { /* Status check failed — fall through. */ }

  // Block duplicate tabs.
  const tabAllowed = await acquireTabLock();
  if (!tabAllowed) {
    document.getElementById('testForm').innerHTML = `
      <div class="card p-8 text-center">
        <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
        <h2 class="text-2xl font-black text-red-600 mt-4">Test Already Open</h2>
        <p class="text-slate-500 mt-3 leading-relaxed">This test is already open in another tab. Please close this tab and continue in your original tab.</p>
        <p class="text-slate-400 text-sm mt-2">If your original tab was closed, click below to try again.</p>
        <button class="btn inline-flex mt-6" onclick="location.reload()">Try Again</button>
      </div>`;
    document.getElementById('submitBtn')?.setAttribute('disabled', 'true');
    submitted = true;
    return;
  }

  // ── Fetch dynamic test configuration ────────────────────────────────────────
  try {
    // Check res.ok before parsing: a non-2xx error body (e.g. 503 HTML) would throw
    // a JSON parse error and leave DURATION and testSections at their fallback values.
    const res  = await fetch('/api/test-info');
    if (!res.ok) throw new Error(`test-info returned ${res.status}`);
    const info = await res.json();
    if (info.duration_minutes && info.duration_minutes > 0) {
      DURATION = info.duration_minutes * 60;
    }
    if (Array.isArray(info.sections) && info.sections.length) {
      testSections = info.sections;
    }
    // Update timer display to reflect actual duration.
    const timerEl = document.getElementById('timer');
    if (timerEl) {
      const m = Math.floor(DURATION / 60);
      const s = DURATION % 60;
      timerEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
  } catch { /* Use fallback DURATION and empty testSections. */ }

  // Sync timer with server's authoritative start time.
  try {
    const startData = await api('/api/start-test', {
      method: 'POST',
      body:   JSON.stringify({ participant_id: Number(participantId) }),
    });
    // Guard: if the server says time has already elapsed, show an expiry screen
    // and record a zero-score submission to prevent re-attempts.
    if (startData.seconds_remaining <= 0) {
      document.getElementById('submitBtn')?.setAttribute('disabled', 'true');
      document.getElementById('testForm').innerHTML = `
        <div class="card p-8 text-center">
          <img src="assets/logo-icon.png" alt="" class="logo-icon mx-auto">
          <h2 class="text-2xl font-black text-red-600 mt-4">Time Has Expired</h2>
          <p class="text-slate-500 mt-3 leading-relaxed">
            Your allotted test time has elapsed. Your attempt has been recorded.
          </p>
          <a href="index.html" class="btn inline-flex mt-6">Back to Home</a>
        </div>`;
      submitted = true;
      localStorage.removeItem('participant_id');
      localStorage.removeItem('test_start_time');
      localStorage.removeItem('passcode_id');
      api('/api/submit-test', {
        method: 'POST',
        body: JSON.stringify({ participant_id: Number(participantId), answers: [] }),
      }).catch(() => {});
      return;
    }
    const seededStart = Date.now() - (DURATION - startData.seconds_remaining) * 1000;
    localStorage.setItem('test_start_time', seededStart.toString());
    testStarted = true; // beacon guard: only auto-submit if start-test succeeded
  } catch { /* Use localStorage value or start fresh. */ }

  loadQuestions(savedAnswersForRestore);
  startTimer();
  startPasscodeWatcher();
  startSectionAvailabilityWatcher();
}
