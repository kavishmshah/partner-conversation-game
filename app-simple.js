import { CATEGORIES, CATEGORY_BY_DICE, findQuestion } from './questions-index.js';

const LS_KEY = 'conversation-game-v1';

const state = {
  session: { dice: 0, categoryId: '', questionId: '' },
  history: [], // {categoryId, questionId, p1Answer, p2Answer}
  cardFlipped: false,
  rolling: false,
  showingAnswers: false,
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

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function pickRandomQuestion(catId) {
  const cat = CATEGORIES.find((c) => c.id === catId);
  if (!cat?.questions.length) return '';
  const q = cat.questions[Math.floor(Math.random() * cat.questions.length)];
  return q.id;
}

function applyDice(d) {
  const cat = CATEGORY_BY_DICE[d];
  if (!cat) return;
  state.session.dice = d;
  state.session.categoryId = cat.id;
  state.session.questionId = pickRandomQuestion(cat.id);
  state.cardFlipped = false;
  state.showingAnswers = false;
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
  
  const catChips = CATEGORIES.map((c, idx) => {
    const n = idx + 1;
    const on = state.session.questionId && c.id === state.session.categoryId;
    return `<button type="button" class="cat-chip ${on ? 'active' : ''}" data-legend="${c.id}" title="${escapeHtml(c.name)}: ${escapeHtml(c.legend)}">
      <span class="emoji">${c.emoji}</span>
      <span>${n}</span>
    </button>`;
  }).join('');
  
  const letters = ['A', 'B', 'C', 'D'];
  const optionsHtml = q ? `
    <div class="opts-grid">
      ${q.options.map((t, i) => `
        <button type="button" class="opt-card" data-p="1" data-i="${i}">
          <span class="opt-key">${letters[i]}</span>
          <span class="opt-text">${escapeHtml(t)}</span>
        </button>
      `).join('')}
    </div>
  ` : '<p class="sub">Roll the dice to draw a question card!</p>';
  
  const dash = compatibilityStats();
  
  appEl.innerHTML = `
    <header>
      <h1>💬 Partner Conversation Game</h1>
      <p class="sub">Roll dice → Discuss the question → See your compatibility!</p>
    </header>
    
    <div class="panel">
      <div class="dice-zone">
        <div class="die ${state.rolling ? 'rolling' : ''}">${state.session.dice >= 1 ? state.session.dice : '🎲'}</div>
        <button type="button" class="btn-dice" id="btn-dice" ${state.rolling ? 'disabled' : ''}>Roll Dice</button>
      </div>
      
      <div class="category-strip">${catChips}</div>
      <p class="sub">Each die number maps to a category (tap chips for descriptions)</p>
      
      <div class="flip-scene">
        <div class="flip-inner ${state.cardFlipped && q ? 'is-flipped' : ''}" id="flip-card">
          <div class="flip-face flip-front" role="button" tabindex="0">
            <div style="font-size:2.5rem;margin-bottom:.5rem">${activeCat ? activeCat.emoji : '🎴'}</div>
            <div class="q-text">${activeCat ? escapeHtml(activeCat.name) : 'Ready to Play?'}</div>
            <p class="flip-hint">${q ? 'Tap to flip back' : 'Roll dice to start'}</p>
          </div>
          <div class="flip-face flip-back">
            <p class="q-text">${q ? escapeHtml(q.text) : ''}</p>
          </div>
        </div>
      </div>
      
      ${q ? `
        <div class="answer-section">
          <h4>💭 Talk it out, then each pick your answer:</h4>
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
      
      <div class="tool-row">
        <button type="button" class="btn-ghost" id="btn-new-card">New Card (Same Category)</button>
        <button type="button" class="btn-ghost" id="btn-stats">View Compatibility</button>
        <button type="button" class="btn-ghost" id="btn-reset">Reset Game</button>
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
    
    <dialog id="legend-dlg"></dialog>
    
    <footer class="note">💡 Single device game - both players answer together!</footer>
  `;
  
  wire();
}

function wire() {
  document.getElementById('btn-dice')?.addEventListener('click', async () => {
    state.rolling = true;
    render();
    await new Promise((r) => setTimeout(r, 500));
    const d = rollDice();
    applyDice(d);
    state.rolling = false;
    render();
    await new Promise((r) => setTimeout(r, 300));
    state.cardFlipped = true;
    persist();
    render();
  });
  
  const flipCard = document.getElementById('flip-card');
  flipCard?.addEventListener('click', () => {
    if (!state.session.questionId) return;
    state.cardFlipped = !state.cardFlipped;
    persist();
    render();
  });
  
  document.getElementById('btn-new-card')?.addEventListener('click', async () => {
    if (!state.session.categoryId) return;
    state.session.questionId = pickRandomQuestion(state.session.categoryId);
    state.cardFlipped = false;
    persist();
    render();
    await new Promise((r) => setTimeout(r, 300));
    state.cardFlipped = true;
    persist();
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
        alert(match ? '✅ You matched!' : '❌ Different answers - great conversation starter!');
        p1Answer = null;
        p2Answer = null;
      }
    });
  });
  
  document.querySelectorAll('.cat-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-legend');
      const cat = CATEGORIES.find((c) => c.id === id);
      const dlg = document.getElementById('legend-dlg');
      if (!cat || !dlg) return;
      dlg.innerHTML = `<article><h3>${escapeHtml(cat.emoji)} ${escapeHtml(cat.name)}</h3><p>${escapeHtml(cat.legend)}</p></article><footer><button type="button" class="btn-ghost" id="legend-close">Close</button></footer>`;
      dlg.showModal();
      document.getElementById('legend-close')?.addEventListener('click', () => dlg.close());
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
    if (confirm('Reset all data? This cannot be undone.')) {
      localStorage.removeItem(LS_KEY);
      state.session = { dice: 0, categoryId: '', questionId: '' };
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
