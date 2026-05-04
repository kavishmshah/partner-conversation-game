import { CATEGORIES, CATEGORY_BY_DICE, findQuestion } from './questions-index.js';

const LS_KEY = 'conversation-game-v1';

const state = {
  session: { categoryId: '', questionId: '' },
  history: [], // {categoryId, questionId, p1Answer, p2Answer}
  cardFlipped: false,
};

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch (e) {
    console.warn('save failed', e);
  }
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.session) state.session = d.session;
    if (d.history) state.history = d.history;
  } catch (e) {
    console.warn('load failed', e);
  }
}

function getAnsweredQuestionsForCategory(catId) {
  return state.history
    .filter(h => h.categoryId === catId)
    .map(h => h.questionId);
}

function pickRandomUnansweredQuestion(catId) {
  const cat = CATEGORIES.find((c) => c.id === catId);
  if (!cat?.questions.length) return '';
  
  const answeredIds = getAnsweredQuestionsForCategory(catId);
  const unanswered = cat.questions.filter(q => !answeredIds.includes(q.id));
  
  // If all answered, allow repeats
  const pool = unanswered.length > 0 ? unanswered : cat.questions;
  const q = pool[Math.floor(Math.random() * pool.length)];
  return q.id;
}

function getNextQuestion() {
  // Pick a random category
  const catIndex = Math.floor(Math.random() * CATEGORIES.length);
  const cat = CATEGORIES[catIndex];
  
  state.session.categoryId = cat.id;
  state.session.questionId = pickRandomUnansweredQuestion(cat.id);
  state.cardFlipped = true;
  persist();
}

function recordAnswers(p1Ans, p2Ans) {
  const { categoryId, questionId } = state.session;
  if (!categoryId || !questionId) return;
  
  // Remove if already answered
  state.history = state.history.filter(
    h => !(h.categoryId === categoryId && h.questionId === questionId)
  );
  
  state.history.push({
    categoryId,
    questionId,
    p1Answer: p1Ans,
    p2Answer: p2Ans,
    timestamp: Date.now()
  });
  
  persist();
}

function compatibilityStats() {
  const byCat = CATEGORIES.map((cat) => {
    let comparable = 0;
    let matches = 0;
    
    state.history.forEach((h) => {
      if (h.categoryId === cat.id && h.p1Answer !== undefined && h.p2Answer !== undefined) {
        comparable++;
        if (h.p1Answer === h.p2Answer) matches++;
      }
    });
    
    const pct = comparable ? Math.round((matches / comparable) * 100) : null;
    return {
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji,
      comparable,
      matches,
      pct,
    };
  });
  
  let totC = 0;
  let totM = 0;
  byCat.forEach((b) => {
    totC += b.comparable;
    totM += b.matches;
  });
  
  const overall = totC ? Math.round((totM / totC) * 100) : null;
  return { byCat, overall, totalComparable: totC };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let appEl = null;

function render() {
  if (!appEl) return;
  
  const activeCat = state.session.categoryId ? CATEGORIES.find((c) => c.id === state.session.categoryId) : null;
  const q = activeCat && state.session.questionId ? findQuestion(activeCat.id, state.session.questionId) : null;
  
  // Calculate progress for each category
  const catProgress = CATEGORIES.map(cat => {
    const answered = getAnsweredQuestionsForCategory(cat.id).length;
    const total = cat.questions.length;
    return { ...cat, answered, total };
  });
  
  const letters = ['A', 'B', 'C', 'D'];
  const dash = compatibilityStats();
  
  appEl.innerHTML = `
    <header>
      <h1>💬 Partner Conversation Game</h1>
      <p class="sub">Discuss questions together → Pick answers → See your compatibility!</p>
    </header>
    
    <div class="panel">
      ${q ? `
        <div class="category-badge">
          <span class="cat-emoji">${activeCat.emoji}</span>
          <div>
            <strong>${escapeHtml(activeCat.name)}</strong>
            <span class="cat-progress">${getAnsweredQuestionsForCategory(activeCat.id).length}/${activeCat.questions.length} answered</span>
          </div>
        </div>
        
        <div class="question-card">
          <p class="q-text">${escapeHtml(q.text)}</p>
        </div>
      ` : `
        <div class="welcome-state">
          <div style="font-size:3rem;margin-bottom:1rem">💕</div>
          <h2>Ready to start?</h2>
          <p class="sub">Get a random conversation question from any category!</p>
        </div>
      `}
      
      <div class="action-row">
        <button type="button" class="btn-primary" id="btn-next">${q ? 'Next Question' : 'Start'}</button>
        ${q ? '<button type="button" class="btn-ghost" id="btn-stats">View Compatibility</button>' : ''}
      </div>
      
      ${q ? `
        <div class="answer-section">
          <h4>💭 Each person picks their answer:</h4>
          <div class="player-cols">
            <div class="player-col">
              <strong>Player 1</strong>
              ${q.options.map((t, i) => `
                <button type="button" class="opt-btn" data-player="1" data-i="${i}">
                  <span class="opt-key">${letters[i]}</span> ${escapeHtml(t)}
                </button>
              `).join('')}
            </div>
            <div class="player-col">
              <strong>Player 2</strong>
              ${q.options.map((t, i) => `
                <button type="button" class="opt-btn" data-player="2" data-i="${i}">
                  <span class="opt-key">${letters[i]}</span> ${escapeHtml(t)}
                </button>
              `).join('')}
            </div>
          </div>
        </div>
      ` : ''}
      
      ${state.history.length > 0 ? `
        <details class="category-progress">
          <summary>📊 Progress by Category (${state.history.length}/132 total)</summary>
          <div class="progress-list">
            ${catProgress.map(c => `
              <div class="progress-item">
                <span>${c.emoji} ${c.name}</span>
                <span class="progress-bar-container">
                  <span class="progress-bar-fill" style="width:${(c.answered/c.total*100)}%"></span>
                </span>
                <span>${c.answered}/${c.total}</span>
              </div>
            `).join('')}
          </div>
        </details>
      ` : ''}
      
      <div class="tool-row">
        ${q ? '<button type="button" class="btn-ghost" id="btn-skip">Skip Question</button>' : ''}
        <button type="button" class="btn-ghost" id="btn-reset">Reset All Data</button>
      </div>
    </div>
    
    <dialog id="stats-dlg">
      <article>
        <h3>📊 Compatibility Scores</h3>
        ${dash.overall !== null
          ? `<p style="font-size:1.5rem;margin:1rem 0"><strong style="color:var(--accent)">${dash.overall}%</strong> aligned across <strong>${dash.totalComparable}</strong> questions</p>`
          : '<p>Answer questions together to see your compatibility!</p>'}
        <div class="dashboard-bars">
          ${dash.byCat.map(b => `
            <div class="dbar">
              <span>${b.emoji} ${b.name}</span>
              <div class="track"><div class="fill" style="width:${b.pct ?? 0}%"></div></div>
              <span>${b.pct !== null ? `${b.pct}%` : '—'}</span>
            </div>
          `).join('')}
        </div>
      </article>
      <footer><button type="button" class="btn-ghost" id="stats-close">Close</button></footer>
    </dialog>
    
    <footer class="note">💡 ${state.history.length > 0 ? `${state.history.length} questions answered so far! ` : ''}No repeats until you complete all 22 in each category</footer>
  `;
  
  wire();
}

function wire() {
  document.getElementById('btn-next')?.addEventListener('click', () => {
    getNextQuestion();
    render();
  });
  
  document.getElementById('btn-skip')?.addEventListener('click', () => {
    getNextQuestion();
    render();
  });
  
  let p1Answer = null;
  let p2Answer = null;
  
  document.querySelectorAll('.opt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const player = btn.getAttribute('data-player');
      const i = Number(btn.getAttribute('data-i'));
      
      if (player === '1') {
        p1Answer = i;
        document.querySelectorAll('[data-player="1"]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      } else {
        p2Answer = i;
        document.querySelectorAll('[data-player="2"]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      }
      
      if (p1Answer !== null && p2Answer !== null) {
        recordAnswers(p1Answer, p2Answer);
        const match = p1Answer === p2Answer;
        setTimeout(() => {
          alert(match ? '✅ You matched! Great minds think alike!' : '❌ Different answers - great conversation starter!');
          p1Answer = null;
          p2Answer = null;
          render(); // Refresh to show updated progress
        }, 100);
      }
    });
  });
  
  document.getElementById('btn-stats')?.addEventListener('click', () => {
    render(); // Refresh stats
    document.getElementById('stats-dlg')?.showModal();
  });
  
  document.getElementById('stats-close')?.addEventListener('click', () => {
    document.getElementById('stats-dlg')?.close();
  });
  
  document.getElementById('btn-reset')?.addEventListener('click', () => {
    if (confirm('Reset all data? This will delete all your answered questions and compatibility scores. This cannot be undone.')) {
      localStorage.removeItem(LS_KEY);
      state.session = { categoryId: '', questionId: '' };
      state.history = [];
      state.cardFlipped = false;
      render();
    }
  });
}

function boot() {
  appEl = document.getElementById('app');
  load();
  render();
}

document.addEventListener('DOMContentLoaded', boot);
