let questions = [];
let submitted = false;
const DURATION = 60 * 60; // seconds
const sectionOrder = ['Analytical Ability', 'Verbal Ability', 'Quantitative Skills'];
const sectionLabels = {
  'Analytical Ability': 'Section A: Analytical Ability',
  'Verbal Ability': 'Section B: Verbal Ability',
  'Quantitative Skills': 'Section C: Quantitative Skills'
};

function updateAnsweredProgress() {
  const answered = questions.filter(q => document.querySelector(`input[name="q_${q.id}"]:checked`)).length;
  const total = questions.length;
  const answeredCount = document.getElementById('answeredCount');
  const progressBar = document.getElementById('progressBar');
  const submitBtn = document.getElementById('submitBtn');

  if (answeredCount) answeredCount.textContent = `${answered}/${total}`;
  if (progressBar) progressBar.style.width = total ? `${(answered / total) * 100}%` : '0%';

  if (submitBtn) {
    const allDone = total > 0 && answered === total;
    submitBtn.disabled = !allDone;
    submitBtn.classList.toggle('opacity-40', !allDone);
    submitBtn.classList.toggle('cursor-not-allowed', !allDone);
  }
}

function renderSection(section, sectionQuestions, startIndex) {
  if (!sectionQuestions.length) return '';
  return `
    <section class="space-y-5">
      <div class="section-banner">
        <div>
          <p class="text-xs uppercase tracking-[0.25em] font-black text-blue-600">${escapeHtml(sectionLabels[section] || section)}</p>
          <h2 class="text-xl sm:text-2xl font-black mt-1">${escapeHtml(section)}</h2>
        </div>
        <span class="pill">${sectionQuestions.length} Questions</span>
      </div>
      ${sectionQuestions.map((q, localIndex) => {
        const globalIndex = startIndex + localIndex + 1;
        return `
        <div class="card question-card p-5 sm:p-6 card-hover">
          <div class="flex items-start gap-3">
            <span class="pill">Q${globalIndex}</span>
            <p class="font-black text-lg leading-relaxed">${escapeHtml(q.question_text)}</p>
          </div>
          <div class="grid sm:grid-cols-2 gap-3 mt-5">
            ${['A','B','C','D'].map(opt => {
              const text = q['option_' + opt.toLowerCase()];
              return `<label class="option-tile"><input type="radio" name="q_${q.id}" value="${opt}" onchange="updateAnsweredProgress()"><span><b>${opt}.</b> ${escapeHtml(text)}</span></label>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </section>`;
}

function initFocusMode() {
  const form = document.getElementById('testForm');
  const mid = () => window.innerHeight / 2;

  function applyScrollFocus() {
    const cards = Array.from(form.querySelectorAll('.question-card'));
    const viewMid = mid();
    const atBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;

    const visible = cards.filter(card => {
      const r = card.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });

    let focused = null;

    if (visible.length) {
      if (atBottom) {
        // At the bottom the last card can never reach midpoint — just pick the last visible one
        focused = visible[visible.length - 1];
      } else {
        let minDist = Infinity;
        visible.forEach(card => {
          const r = card.getBoundingClientRect();
          const dist = Math.abs((r.top + r.bottom) / 2 - viewMid);
          if (dist < minDist) { minDist = dist; focused = card; }
        });
      }
    }

    cards.forEach(card => {
      if (focused) {
        card.classList.toggle('q-focused', card === focused);
        card.classList.toggle('q-blurred', card !== focused);
      } else {
        card.classList.remove('q-focused', 'q-blurred');
      }
    });
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => { applyScrollFocus(); ticking = false; });
      ticking = true;
    }
  }, { passive: true });

  applyScrollFocus();
}

async function loadQuestions() {
  try {
    questions = (await api('/api/questions')) || [];
    const form = document.getElementById('testForm');
    if (!questions.length) {
      form.innerHTML = `<div class="card p-8 text-center"><h2 class="text-xl font-black">No questions available</h2><p class="text-slate-500 mt-2">Please contact the administrator.</p></div>`;
      return;
    }
    let startIndex = 0;
    form.innerHTML = sectionOrder.map(section => {
      const sectionQuestions = questions.filter(q => q.section === section);
      const html = renderSection(section, sectionQuestions, startIndex);
      startIndex += sectionQuestions.length;
      return html;
    }).join('') + renderSection('Other Questions', questions.filter(q => !sectionOrder.includes(q.section)), startIndex);
    updateAnsweredProgress();
    initFocusMode();
  } catch (err) {
    setMessage('message', err.message, true);
  }
}

function startTimer() {
  // Store start time on first load; reuse the same stamp on every reload
  if (!localStorage.getItem('test_start_time')) {
    localStorage.setItem('test_start_time', Date.now().toString());
  }
  const startTime = parseInt(localStorage.getItem('test_start_time'), 10);

  function tick() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, DURATION - elapsed);
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const timer = document.getElementById('timer');
    if (timer) {
      timer.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
      if (remaining <= 300) timer.parentElement.classList.add('animate-pulse');
    }
    if (remaining <= 0) {
      clearInterval(interval);
      submitTest(true);
    }
  }

  tick(); // paint correct time immediately on load / reload
  const interval = setInterval(tick, 1000);
}

async function submitTest(auto = false) {
  if (submitted) return;
  if (!auto) {
    const confirmSubmit = await showConfirm('Submit your test now? You cannot change answers after submission.', 'Submit Test', 'Submit');
    if (!confirmSubmit) return;
  }
  submitted = true;
  const participantId = Number(localStorage.getItem('participant_id'));
  const answers = questions.map(q => {
    const selected = document.querySelector(`input[name="q_${q.id}"]:checked`);
    return { question_id: q.id, selected_option: selected ? selected.value : '' };
  });

  try {
    await api('/api/submit-test', {
      method: 'POST',
      body: JSON.stringify({ participant_id: participantId, answers }),
    });
    localStorage.removeItem('participant_id');
    localStorage.removeItem('test_start_time');
    document.body.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6">
        <div class="glass-card p-8 max-w-lg text-center">
          <img src="assets/logo-icon.png" alt="DAES logo" class="logo-icon mx-auto">
          <h1 class="text-3xl font-black text-green-700 mt-5">Thank You for Participating</h1>
          <p class="text-slate-600 mt-3 leading-relaxed">Your answers have been submitted successfully. Please wait for good news from the administrator.</p>
          <div class="rounded-2xl bg-green-50 border border-green-100 p-4 mt-6 text-green-800 font-bold">Your result will be reviewed and announced by the administrator.</div>
          <a href="index.html" class="btn inline-flex mt-6">Back to Home</a>
        </div>
      </div>`;
  } catch (err) {
    submitted = false;
    setMessage('message', err.message, true);
  }
}

document.getElementById('submitBtn')?.addEventListener('click', () => submitTest(false));

// Warn before refresh / tab-close / navigation away while the test is active
window.addEventListener('beforeunload', e => {
  if (!submitted) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Block F5 / Ctrl+R / Ctrl+Shift+R keyboard shortcuts directly
document.addEventListener('keydown', e => {
  if (submitted) return;
  if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
    e.preventDefault();
  }
});

(async function initTest() {
  const participantId = localStorage.getItem('participant_id');

  // No participant on record — send back to home
  if (!participantId) {
    window.location.href = 'index.html';
    return;
  }

  // Check whether this participant has already submitted
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
      submitted = true; // disables the beforeunload guard
      return;
    }
  } catch {
    // If the check itself fails, fall through and allow the test to load
  }

  loadQuestions();
  startTimer();
}());
