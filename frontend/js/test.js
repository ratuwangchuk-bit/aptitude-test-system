let questions           = [];
let submitted           = false;
let currentQuestionIdx  = 0;
const selectedAnswers   = {}; // { [question_id]: 'A'|'B'|'C'|'D' } — survives question navigation
const DURATION          = 60 * 60; // Total test duration in seconds (60 minutes).

// ── Single-tab enforcement ─────────────────────────────────────────────────────
// Only one browser tab per participant may hold the test open at a time.
// A BroadcastChannel allows tabs on the same origin to message each other.
// When a new tab opens it broadcasts a "check" message; if an existing active tab
// responds with "active", the new tab knows it is a duplicate and blocks itself.
const _tabChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('daes_test_tab')
  : null;
let _isActiveTab = false;

_tabChannel?.addEventListener('message', e => {
  if (e.data.type === 'check' && _isActiveTab) {
    _tabChannel.postMessage({ type: 'active' });
  }
});

/**
 * Attempts to claim the single-tab lock for this participant.
 * Resolves true if no other tab responded "active" within 150 ms.
 */
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

// Canonical section order and display metadata.
const sectionOrder = ['Analytical Ability', 'Verbal Ability', 'Quantitative Skills'];

const sectionLetters = {
  'Analytical Ability':  'A',
  'Verbal Ability':      'B',
  'Quantitative Skills': 'C',
};

const sectionTabLabels = {
  'Analytical Ability':  'Analytical Ability',
  'Verbal Ability':      'Verbal Ability',
  'Quantitative Skills': 'Quantitative Skills',
};

/* ── Progress tracking ─────────────────────────────────────────────────────── */

/**
 * Counts answered questions from selectedAnswers (not the DOM, since only one
 * question is rendered at a time). Updates the topbar counter, progress bar,
 * and submit button, then refreshes the sidebar and section tab indicators.
 */
function updateAnsweredProgress() {
  const answered = questions.filter(q => selectedAnswers[q.id]).length;
  const total    = questions.length;

  const answeredEl  = document.getElementById('answeredCount');
  const progressBar = document.getElementById('progressBar');
  const submitBtn   = document.getElementById('submitBtn');

  if (answeredEl)  answeredEl.textContent = `${answered}/${total}`;
  if (progressBar) progressBar.style.width = total ? `${(answered / total) * 100}%` : '0%';

  if (submitBtn) {
    const allDone = total > 0 && answered === total;
    submitBtn.disabled = !allDone;
    submitBtn.classList.toggle('opacity-40',        !allDone);
    submitBtn.classList.toggle('cursor-not-allowed', !allDone);
  }

  updateSidebarButtons();
  updateSectionTabs();
}

/* ── Sidebar + section tab bar ─────────────────────────────────────────────── */

/**
 * Builds the left sidebar (question number grid per section) and the section
 * tab bar (A / B / C with answered/total counts). Called once after questions load.
 */
function buildSidebarAndTabs() {
  const sidebar = document.getElementById('testSidebar');
  const tabBar  = document.getElementById('testSectionBar');
  if (!sidebar || !tabBar) return;

  let globalIdx = 0;
  let tabsHtml  = '';
  let sideHtml  = '';

  sectionOrder.forEach(section => {
    const sq     = questions.filter(q => q.section === section);
    if (!sq.length) return;
    const letter = sectionLetters[section] || '?';

    tabsHtml += `
      <button class="tab-btn" id="tabBtn_${letter}"
              onclick="jumpToSection('${section}')">
        ${letter} &middot; ${sectionTabLabels[section] || section}
        <span class="tab-score" id="tabScore_${letter}">0/${sq.length}</span>
      </button>`;

    sideHtml += `<div class="sb-section-header"><span class="sb-dot"></span>Section ${letter}</div><div class="sb-grid">`;
    sq.forEach((q, li) => {
      sideHtml += `<button class="sb-q" id="sbq_${globalIdx}" onclick="goToQuestion(${globalIdx})">${li + 1}</button>`;
      globalIdx++;
    });
    sideHtml += '</div>';
  });

  tabBar.innerHTML  = tabsHtml;
  sidebar.innerHTML = sideHtml;
}

/**
 * Repaints every sidebar button: current = orange, answered = blue, else default.
 */
function updateSidebarButtons() {
  questions.forEach((q, gi) => {
    const btn = document.getElementById(`sbq_${gi}`);
    if (!btn) return;
    const isCurrent  = gi === currentQuestionIdx;
    const isAnswered = Boolean(selectedAnswers[q.id]);
    btn.className = 'sb-q' + (isCurrent ? ' sq-current' : isAnswered ? ' sq-answered' : '');
  });
}

/**
 * Updates the per-section answered/total scores in the tab bar and highlights
 * the tab that owns the currently visible question.
 */
function updateSectionTabs() {
  const activeSection = questions[currentQuestionIdx]?.section;

  sectionOrder.forEach(section => {
    const letter = sectionLetters[section];
    const sq     = questions.filter(q => q.section === section);
    const done   = sq.filter(q => selectedAnswers[q.id]).length;

    const scoreEl = document.getElementById(`tabScore_${letter}`);
    if (scoreEl) scoreEl.textContent = `${done}/${sq.length}`;

    const tabEl = document.getElementById(`tabBtn_${letter}`);
    if (tabEl) tabEl.classList.toggle('tab-active', section === activeSection);
  });
}

/* ── Markdown table renderer ───────────────────────────────────────────────── */

/**
 * Converts pipe-delimited markdown tables embedded in question text to HTML.
 * Non-table lines are wrapped in <p> tags. All cell content is passed through
 * escapeHtml so no user-supplied markup can reach the DOM.
 *
 * Supports:
 *   | Header | Header |       ← thead
 *   |--------|--------|       ← separator (detected, not rendered)
 *   | Cell   | Cell   |       ← tbody
 *
 * Tables without a separator row are treated as body-only (no <thead>).
 * Mixed text + table questions work correctly — text renders above/below the table.
 */
function renderQuestionText(raw) {
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    // A table block is a run of consecutive lines that contain a pipe character.
    if (lines[i].includes('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      // Parse each line: strip leading/trailing pipes, split on |, trim cells.
      const rows = tableLines.map(l =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
      );

      // A separator row contains only dashes, colons, and spaces in every cell.
      const isSep = r => r.every(c => /^[-:\s]+$/.test(c));
      const sepIdx = rows.findIndex(isSep);

      const headerRows = sepIdx > 0 ? rows.slice(0, sepIdx) : [];
      const dataRows   = sepIdx >= 0 ? rows.slice(sepIdx + 1) : rows;

      let html = '<table class="q-table">';
      if (headerRows.length) {
        html += '<thead>' +
          headerRows.map(r =>
            '<tr>' + r.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>'
          ).join('') +
          '</thead>';
      }
      if (dataRows.length) {
        html += '<tbody>' +
          dataRows.map(r =>
            '<tr>' + r.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>'
          ).join('') +
          '</tbody>';
      }
      html += '</table>';
      parts.push(html);
    } else {
      const text = escapeHtml(lines[i]);
      parts.push(text.trim() ? `<p class="q-text-para">${text}</p>` : '');
      i++;
    }
  }

  return parts.join('');
}

/* ── Question display ──────────────────────────────────────────────────────── */

/**
 * Renders question at global index `idx` into the question panel.
 * Reads the saved answer from `selectedAnswers` so the tile is pre-selected
 * when the participant navigates back to a previously answered question.
 */
function showQuestion(idx) {
  if (idx < 0 || idx >= questions.length) return;
  currentQuestionIdx = idx;

  const q          = questions[idx];
  const section    = q.section || 'Other';
  const letter     = sectionLetters[section] || '';
  const badgeLabel = letter ? `Section ${letter}  ·  ${section}` : section;

  const sectionQs = questions.filter(sq => sq.section === section);
  const localIdx  = sectionQs.indexOf(q);
  const saved     = selectedAnswers[q.id] || '';

  const form = document.getElementById('testForm');
  if (!form) return;

  form.innerHTML = `
    <div class="q-section-badge">
      <span class="q-badge-dot"></span>
      ${escapeHtml(badgeLabel)}
    </div>
    <p class="q-meta">
      <span>Question ${localIdx + 1} of ${sectionQs.length}</span>
      <span class="sep">|</span>
      <span>Overall ${idx + 1} of ${questions.length}</span>
    </p>
    <div class="q-text-card">${renderQuestionText(q.question_text)}</div>
    <div class="q-options">
      ${['A','B','C','D'].map(opt => {
        const text   = q['option_' + opt.toLowerCase()];
        const selCls = saved === opt ? ' q-selected' : '';
        return `
          <label class="q-opt${selCls}" id="qopt_${q.id}_${opt}"
                 onclick="onOptionChange(${q.id},'${opt}')">
            <span class="q-opt-badge">${opt}</span>
            <span>${escapeHtml(text)}</span>
          </label>`;
      }).join('')}
    </div>
    <div class="q-nav">
      <button class="q-nav-btn" onclick="goToQuestion(${idx - 1})" ${idx === 0 ? 'disabled' : ''}>
        &#8592; Previous
      </button>
      <button class="q-nav-btn q-next" onclick="goToQuestion(${idx + 1})"
              ${idx === questions.length - 1 ? 'disabled' : ''}>
        Next &#8594;
      </button>
    </div>`;

  // Scroll the question panel back to the top when switching questions.
  document.querySelector('.test-q-panel')?.scrollTo({ top: 0, behavior: 'smooth' });

  updateSidebarButtons();
  updateSectionTabs();
}

/**
 * Records the chosen option, updates tile styling, then refreshes progress.
 * Uses the `selectedAnswers` map so answers persist across question navigation
 * without requiring all radio inputs to remain in the DOM simultaneously.
 */
function onOptionChange(qId, opt) {
  selectedAnswers[qId] = opt;

  // Deselect all tiles for this question, then select the chosen one.
  ['A','B','C','D'].forEach(o => {
    document.getElementById(`qopt_${qId}_${o}`)?.classList.remove('q-selected');
  });
  document.getElementById(`qopt_${qId}_${opt}`)?.classList.add('q-selected');

  updateAnsweredProgress();
}

/** Navigates to the question at global index `idx`. */
function goToQuestion(idx) {
  if (idx < 0 || idx >= questions.length) return;
  showQuestion(idx);
}

/** Jumps to the first question in the given section. */
function jumpToSection(section) {
  const idx = questions.findIndex(q => q.section === section);
  if (idx !== -1) goToQuestion(idx);
}

/* ── Question loading ──────────────────────────────────────────────────────── */

/**
 * Fetches questions from the API, builds the sidebar and tab bar, then shows
 * the first question. If savedAnswers are provided (from reload recovery), they
 * are restored into `selectedAnswers` before rendering so the participant does
 * not lose progress across page reloads.
 */
async function loadQuestions(savedAnswers = null) {
  try {
    questions = (await api('/api/questions')) || [];
    const form = document.getElementById('testForm');

    if (!questions.length) {
      form.innerHTML = `
        <div class="card p-8 text-center">
          <h2 class="text-xl font-black">No questions available</h2>
          <p class="text-slate-500 mt-2">Please contact the administrator.</p>
        </div>`;
      return;
    }

    const totalEl = document.getElementById('questionTotal');
    if (totalEl) totalEl.textContent = questions.length;

    buildSidebarAndTabs();

    // Restore answers from reload checkpoint before the first render.
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

/* ── Passcode expiry watcher ───────────────────────────────────────────────── */

/**
 * Polls /api/passcode-status every 30 seconds. If the passcode is deleted or
 * expires while the participant is mid-test, shows a warning banner and
 * auto-submits after a 3-second grace period so answers are not lost.
 */
function startPasscodeWatcher() {
  const passcodeId = Number(localStorage.getItem('passcode_id'));
  if (!passcodeId) return;

  const interval = setInterval(async () => {
    if (submitted) { clearInterval(interval); return; }
    try {
      const res  = await fetch(`/api/passcode-status/${passcodeId}`);
      const data = await res.json().catch(() => ({}));
      if (!data.valid) {
        clearInterval(interval);

        // Show a prominent warning banner above the question panel.
        const banner = document.createElement('div');
        banner.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
          'background:#7f1d1d', 'border-bottom:2px solid #ef4444',
          'color:#fca5a5', 'font-weight:800', 'font-size:0.9rem',
          'padding:0.9rem 1.5rem', 'text-align:center',
        ].join(';');
        banner.textContent = '⚠  The session passcode has expired. Your answers are being submitted automatically…';
        document.body.prepend(banner);

        setTimeout(() => submitTest(true), 3000);
      }
    } catch { /* Network error — wait for next tick. */ }
  }, 30000);
}

/* ── Timer ─────────────────────────────────────────────────────────────────── */

/**
 * Starts the countdown timer. The server's authoritative start time is stored
 * in localStorage so the clock survives page reloads without resetting.
 */
function startTimer() {
  const stored   = localStorage.getItem('test_start_time');
  const storedMs = stored ? parseInt(stored, 10) : NaN;
  const isStale  = !stored || isNaN(storedMs) || (Date.now() - storedMs) >= DURATION * 1000;
  if (isStale) localStorage.setItem('test_start_time', Date.now().toString());

  const startTime = parseInt(localStorage.getItem('test_start_time'), 10);

  function tick() {
    const elapsed   = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, DURATION - elapsed);
    const minutes   = Math.floor(remaining / 60);
    const seconds   = remaining % 60;
    const timer     = document.getElementById('timer');
    if (timer) {
      timer.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
      // Pulse animation when ≤ 5 minutes remain.
      if (remaining <= 300) timer.parentElement.classList.add('animate-pulse');
    }
    if (remaining <= 0) { clearInterval(interval); submitTest(true); }
  }

  tick();
  const interval = setInterval(tick, 1000);
}

/* ── Submission ────────────────────────────────────────────────────────────── */

/**
 * Collects all answers from `selectedAnswers` (not the DOM) and submits.
 * auto=true skips the confirmation dialog (used by the timer auto-submit).
 */
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
    submitted = false;
    setMessage('message', err.message, true);
  }
}

document.getElementById('submitBtn')?.addEventListener('click', () => submitTest(false));

document.addEventListener('copy',        e => { e.preventDefault(); });
document.addEventListener('contextmenu', e => { e.preventDefault(); });

/* ── Beacon auto-submit (tab close / navigation away) ─────────────────────── */

/**
 * Fires the answers via sendBeacon so they are delivered even while the page
 * tears down. Reads from `selectedAnswers` rather than the DOM so all answers
 * are captured regardless of which question is currently displayed.
 * A sessionStorage checkpoint is written before the beacon so that the next
 * page load (a reload) can cancel the submission and restore answers.
 */
function autoSubmitViaBeacon() {
  const participantId = Number(localStorage.getItem('participant_id'));
  if (!participantId || questions.length === 0) return;

  const answers = questions.map(q => ({
    question_id:     q.id,
    selected_option: selectedAnswers[q.id] || '',
  }));

  // Checkpoint before beacon so the cancel handler can read it on reload.
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

/**
 * Cancels an auto-submission made within the last 60 seconds.
 * Retries up to 3 times with 400 ms gaps to survive the race between the
 * sendBeacon arriving at the server and this cancellation request.
 */
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

// Warn the participant before leaving while the test is active.
window.addEventListener('beforeunload', e => {
  if (!submitted) { e.preventDefault(); e.returnValue = ''; }
});

// Auto-submit when the participant confirms "Leave" or on mobile without dialog.
window.addEventListener('pagehide', () => {
  if (!submitted) autoSubmitViaBeacon();
});

/* ── Entry point ───────────────────────────────────────────────────────────── */

/**
 * Called by the fullscreen prompt button after the participant enters fullscreen.
 * Handles reload recovery (cancels the pagehide beacon, restores answers), checks
 * for already-submitted state, enforces single-tab lock, syncs the timer, then
 * loads questions and starts the countdown.
 */
async function initTest() {
  const participantId = localStorage.getItem('participant_id');
  if (!participantId) { window.location.href = 'index.html'; return; }

  // ── Reload recovery ──────────────────────────────────────────────────────────
  // pagehide fires on both reload and close. sessionStorage survives reload but
  // is wiped on close — that asymmetry lets us cancel the beacon on reload only.
  const navType    = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const sessionRaw = sessionStorage.getItem('_testSession');
  let savedAnswersForRestore = null;

  if (navType === 'reload' && sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw);
      if (session.participantId === Number(participantId)) {
        await cancelAutoSubmit(session.participantId);
        savedAnswersForRestore = session.answers; // Restore answers after cancel.
      }
    } catch { /* Malformed checkpoint — ignore. */ }
    sessionStorage.removeItem('_testSession');
  }

  // Block if the participant has already submitted.
  try {
    const status = await api(`/api/submission-status/${participantId}`);
    if (status.submitted) {
      localStorage.removeItem('participant_id');
      localStorage.removeItem('test_start_time');
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
  } catch {
    // Status check failed — fall through and allow the test to load.
  }

  // Block duplicate tabs.
  const tabAllowed = await acquireTabLock();
  if (!tabAllowed) {
    document.getElementById('testForm').innerHTML = `
      <div class="card p-8 text-center">
        <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
        <h2 class="text-2xl font-black text-red-600 mt-4">Test Already Open</h2>
        <p class="text-slate-500 mt-3 leading-relaxed">This test is already open in another tab or window. Please close this tab and continue in your original tab.</p>
      </div>`;
    document.getElementById('submitBtn')?.setAttribute('disabled', 'true');
    submitted = true;
    return;
  }

  // Synchronise the timer with the server so all reloads show identical time.
  try {
    const startData = await api('/api/start-test', {
      method: 'POST',
      body:   JSON.stringify({ participant_id: Number(participantId) }),
    });
    const seededStart = Date.now() - (DURATION - startData.seconds_remaining) * 1000;
    localStorage.setItem('test_start_time', seededStart.toString());
  } catch {
    // Network error — use localStorage value or start fresh.
  }

  loadQuestions(savedAnswersForRestore);
  startTimer();
  startPasscodeWatcher();
}
