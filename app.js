import { CATEGORIES, CATEGORY_BY_DICE, findQuestion } from './questions-index.js';

const LS_PREFIX = 'pcg-v1';
const SYNC_URL = 'wss://demos.yjs.dev';
const USE_WEBRTC = true; // Use WebRTC peer-to-peer instead of WebSocket (works across different networks!)

// WebRTC signaling servers (for initial peer discovery only)
const WEBRTC_SIGNALING = [
  'wss://signaling.yjs.dev',
  'wss://y-webrtc-signaling-eu.herokuapp.com',
  'wss://y-webrtc-signaling-us.herokuapp.com'
];

/**
 * Your shared room code — both phones use this when you leave the field as-is.
 * Change the string to whatever you like (letters, numbers, dashes).
 */
const FIXED_ROOM_CODE = 'PARTNER-ROOM';

/** If true, the room field is hidden and FIXED_ROOM_CODE is always used. */
const USE_FIXED_ROOM_ONLY = false;

const FLIP_AFTER_ROLL_MS = 320;

/** @typedef {'p1' | 'p2'} Role */

/** @type {{
 *   room: string,
 *   myRole: Role | '',
 *   p1Name: string,
 *   p2Name: string,
 *   session: { dice: number, categoryId: string, questionId: string },
 *   answers: { p1: Record<string, Record<string, number>>, p2: Record<string, Record<string, number>> },
 *   tab: 'play' | 'dashboard',
 *   cardFlipped: boolean,
 *   rolling: boolean,
 *   syncStatus: 'idle' | 'connecting' | 'synced' | 'offline',
 * }} */
const S = {
  room: '',
  myRole: '',
  p1Name: '',
  p2Name: '',
  session: { dice: 0, categoryId: '', questionId: '' },
  answers: { p1: {}, p2: {} },
  tab: 'play',
  cardFlipped: false,
  rolling: false,
  syncStatus: 'idle',
};

let ydoc = null;
let yAnswers = null;
let yMeta = null;
let ySession = null;
let provider = null;
let afterTxn = null;
let connectSlowTimer = null;

/** Same room string on both phones after join (lowercase, no spaces). */
function normalizeRoomCode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
}

function yjsDocRoomId() {
  return S.room ? `pcg-${S.room}` : '';
}

function disconnectYjs() {
  if (connectSlowTimer) {
    clearTimeout(connectSlowTimer);
    connectSlowTimer = null;
  }
  if (provider) {
    try {
      provider.destroy();
    } catch (e) {
      /* ignore */
    }
    provider = null;
  }
  if (ydoc && afterTxn) {
    try {
      ydoc.off('afterTransaction', afterTxn);
    } catch (e) {
      /* ignore */
    }
  }
  afterTxn = null;
  ydoc = null;
  yAnswers = null;
  yMeta = null;
  ySession = null;
}

function storageKey() {
  return `${LS_PREFIX}:${S.room}`;
}

function persist() {
  if (!S.room) return;
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        ...S,
        savedAt: Date.now(),
      })
    );
  } catch (e) {
    console.warn('save failed', e);
  }
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.p1Name) S.p1Name = d.p1Name;
    if (d.p2Name) S.p2Name = d.p2Name;
    if (d.myRole) S.myRole = d.myRole;
    if (d.session) S.session = { ...S.session, ...d.session };
    if (d.answers) {
      S.answers = {
        p1: d.answers.p1 || {},
        p2: d.answers.p2 || {},
      };
    }
  } catch (e) {
    console.warn('load failed', e);
  }
}

function mirrorToLocalFromY() {
  if (!yAnswers || !yMeta || !ySession) return;
  S.p1Name = yMeta.get('p1Name') || S.p1Name;
  S.p2Name = yMeta.get('p2Name') || S.p2Name;
  const d = Number(ySession.get('dice'));
  if (!Number.isNaN(d) && d >= 1 && d <= 6) S.session.dice = d;
  const cid = ySession.get('categoryId');
  if (cid) S.session.categoryId = cid;
  const qid = ySession.get('questionId');
  if (qid !== undefined && qid !== '') S.session.questionId = qid;
  if (S.session.questionId) S.cardFlipped = true;

  S.answers = { p1: {}, p2: {} };
  yAnswers.forEach((val, key) => {
    const m = String(key).match(/^a:(p1|p2):([^:]+):(.+)$/);
    if (!m) return;
    const role = m[1];
    const cat = m[2];
    const q = m[3];
    if (!S.answers[role][cat]) S.answers[role][cat] = {};
    S.answers[role][cat][q] = val;
  });
}

function sessionHasActiveCard() {
  return (
    S.session.dice >= 1 &&
    S.session.dice <= 6 &&
    Boolean(S.session.categoryId) &&
    Boolean(S.session.questionId)
  );
}

function pushLocalIntoY() {
  if (!yAnswers || !yMeta || !ySession) return;
  if (S.p1Name) yMeta.set('p1Name', S.p1Name);
  if (S.p2Name) yMeta.set('p2Name', S.p2Name);
  /**
   * Never publish an “empty” session (dice 0 / no card). That was overwriting a partner’s
   * roll when the second device joined or synced — same bug as different dice on each phone.
   */
  if (sessionHasActiveCard()) {
    if (ydoc) {
      ydoc.transact(() => {
        ySession.set('dice', S.session.dice);
        ySession.set('categoryId', S.session.categoryId);
        ySession.set('questionId', S.session.questionId);
      });
    } else {
      ySession.set('dice', S.session.dice);
      ySession.set('categoryId', S.session.categoryId);
      ySession.set('questionId', S.session.questionId);
    }
  }

  ['p1', 'p2'].forEach((role) => {
    const byCat = S.answers[role] || {};
    Object.keys(byCat).forEach((catId) => {
      Object.keys(byCat[catId] || {}).forEach((qid) => {
        const k = `a:${role}:${catId}:${qid}`;
        if (yAnswers.get(k) === undefined) {
          yAnswers.set(k, byCat[catId][qid]);
        }
      });
    });
  });
}

function setAnswer(role, catId, qid, optionIndex) {
  if (!S.answers[role][catId]) S.answers[role][catId] = {};
  S.answers[role][catId][qid] = optionIndex;
  if (yAnswers) {
    yAnswers.set(`a:${role}:${catId}:${qid}`, optionIndex);
  }
  persist();
}

function setNames() {
  if (yMeta) {
    if (S.p1Name) yMeta.set('p1Name', S.p1Name);
    if (S.p2Name) yMeta.set('p2Name', S.p2Name);
  }
  persist();
}

function rollDiceValue() {
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
  S.session.dice = d;
  S.session.categoryId = cat.id;
  S.session.questionId = pickRandomQuestion(cat.id);
  /* Flip to question happens after a short delay in the dice handler (local). */
  S.cardFlipped = false;
  if (ySession && ydoc) {
    ydoc.transact(() => {
      ySession.set('dice', d);
      ySession.set('categoryId', cat.id);
      ySession.set('questionId', S.session.questionId);
    });
  } else if (ySession) {
    ySession.set('dice', d);
    ySession.set('categoryId', cat.id);
    ySession.set('questionId', S.session.questionId);
  }
  persist();
}

function compatibilityStats() {
  const byCat = CATEGORIES.map((cat) => {
    let comparable = 0;
    let matches = 0;
    cat.questions.forEach((q) => {
      const i1 = S.answers.p1[cat.id]?.[q.id];
      const i2 = S.answers.p2[cat.id]?.[q.id];
      if (i1 !== undefined && i2 !== undefined) {
        comparable++;
        if (i1 === i2) matches++;
      }
    });
    const pct = comparable ? Math.round((matches / comparable) * 100) : null;
    return {
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji,
      hue: cat.hue,
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
  const stat =
    S.syncStatus === 'synced'
      ? '<span class="badge sync">P2P sync active</span>'
      : S.syncStatus === 'connecting'
        ? '<span class="badge">Waiting for partner…</span>'
        : '<span class="badge offline">Local mode — use Export/Import to sync</span>';
  const syncActions =
    S.syncStatus === 'synced'
      ? '<p class="help-box" style="margin-top:0.5rem;font-size:0.82rem;background:#1a3a1a;border-left:3px solid #5ecf8a">✓ Connected via peer-to-peer WebRTC — dice rolls and answers sync automatically!</p>'
      : `<button type="button" class="btn-ghost" id="btn-reconnect" style="margin-top:0.35rem">Retry connection</button>
         <p class="help-box" style="margin-top:0.5rem;font-size:0.82rem;background:#3a3a1a;border-left:3px solid #f0c14a">
           <strong>⏳ Waiting for partner to join...</strong><br>
           Make sure your partner opens the SAME room code on their device. Uses WebRTC peer-to-peer (works across different networks!).<br>
           Both devices must be online at the same time. If connection fails, use <strong>Export/Import backup</strong> buttons below.
         </p>`;

  const activeCat =
    S.session.categoryId && S.session.questionId
      ? CATEGORIES.find((c) => c.id === S.session.categoryId)
      : null;
  const q =
    S.session.questionId && activeCat
      ? findQuestion(activeCat.id, S.session.questionId)
      : null;

  const dash = compatibilityStats();

  const catChips = CATEGORIES.map((c, idx) => {
    const n = idx + 1;
    const on = S.session.questionId && c.id === S.session.categoryId;
    return `<button type="button" class="cat-chip ${on ? 'active' : ''}" data-legend="${c.id}" title="${escapeHtml(c.name)}: ${escapeHtml(c.legend)}">
      <span class="emoji">${c.emoji}</span>
      <span>${n}</span>
    </button>`;
  }).join('');

  const optButtons = (role) => {
    if (!q || !activeCat) {
      return '<p class="sub" style="margin:0">Roll <strong>Dice Roll!</strong> to draw a card, then pick A–D here.</p>';
    }
    const cur = S.answers[role][activeCat.id]?.[q.id];
    const letters = ['A', 'B', 'C', 'D'];
    const label = role === 'p1' ? 'Player 1' : 'Player 2';
    const disp = role === 'p1' ? S.p1Name || 'Player 1' : S.p2Name || 'Player 2';
    return `
      <div class="player-answers">
        <strong>${escapeHtml(label)} — ${escapeHtml(disp)}</strong>
        <div class="opts" role="group" aria-label="Answers for ${escapeHtml(disp)}">
          ${q.options
            .map(
              (t, i) => `
            <button type="button" class="opt-btn ${cur === i ? 'selected' : ''}" data-role="${role}" data-i="${i}">
              <span class="opt-key">${letters[i]}</span>
              <span>${escapeHtml(t)}</span>
            </button>`
            )
            .join('')}
        </div>
      </div>`;
  };

  const answersHint =
    !q || !activeCat
      ? `<div class="mc-grid">${optButtons('p1')}</div>`
      : `<div class="mc-grid">${optButtons('p1')}${optButtons('p2')}</div>`;

  const dashboardHtml =
    S.tab === 'dashboard'
      ? `
    <div class="panel">
      <h2 style="margin:0 0 .5rem;font-size:1rem;">Compatibility</h2>
      <p class="sub" style="margin-top:0;">
        ${dash.overall !== null
          ? `<strong style="color:var(--accent)">${dash.overall}%</strong> choice alignment across <strong>${dash.totalComparable}</strong> questions both answered.`
          : 'Answer the same questions as your partner to see alignment.'}
      </p>
      <div class="dashboard-bars">
        ${dash.byCat
          .map(
            (b) => `
          <div class="dbar">
            <span>${b.emoji}</span>
            <div class="track"><div class="fill" style="width:${b.pct ?? 0}%"></div></div>
            <span>${b.pct !== null ? `${b.pct}%` : '—'}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`
      : '';

  const playHtml =
    S.tab === 'play'
      ? `
    <div class="panel">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <span>Room: <strong>${escapeHtml(S.room)}</strong></span>
        <span style="text-align:right">${stat}</span>
      </div>
      <p class="sub" style="margin:0.35rem 0 0;font-size:0.82rem">
        Room: <code class="code-tag">${escapeHtml(yjsDocRoomId())}</code>
        — both devices auto-sync via WebRTC peer-to-peer. Same room code, one device is Player 1, other is Player 2.
      </p>
      ${syncActions}
      <div class="dice-zone">
        <div class="die ${S.rolling ? 'rolling' : ''}" aria-live="polite">${S.session.dice >= 1 ? S.session.dice : '•'}</div>
        <button type="button" class="btn-dice" id="btn-dice" ${S.rolling ? 'disabled' : ''}>Dice Roll!</button>
      </div>
      <p class="help-box"><strong>One device taps Dice Roll!</strong> — both screens share that roll (avoid rolling at the same time on both phones).</p>
      <p class="help-box">Die shows <strong>1–6</strong>. Each number maps to a category below. Your answer choices stay <strong>below the card</strong> so nothing is covered.</p>
      <div class="category-strip">${catChips}</div>
      <p class="sub" style="margin:0.25rem 0 0;">Legend: tap a category chip for a short description.</p>

      <div class="flip-scene">
        <div class="flip-inner ${S.cardFlipped && q ? 'is-flipped' : ''}" id="flip-inner">
          <div class="flip-face flip-front" id="flip-front" role="button" tabindex="0" aria-label="Flip to reveal question">
            <div style="font-size:2rem;margin-bottom:.35rem">${activeCat ? activeCat.emoji : '🎴'}</div>
            <div class="q-text">${activeCat ? escapeHtml(activeCat.name) : 'Ready?'}</div>
            <p class="flip-hint">${q ? (S.cardFlipped ? 'Tap to see category side again' : 'Question flips in automatically after you roll') : 'Use Dice Roll! to draw a card'}</p>
          </div>
          <div class="flip-face flip-back">
            <p class="q-text">${q ? escapeHtml(q.text) : ''}</p>
          </div>
        </div>
      </div>

      <div class="answer-deck">
        <h4>Choose answers (multiple choice)</h4>
        ${answersHint}
        <div class="tool-row">
          <button type="button" class="btn-ghost" id="btn-another">New card — same category</button>
          <button type="button" class="btn-ghost" id="btn-export">Export backup</button>
          <label class="btn-ghost" style="cursor:pointer;margin:0;display:inline-flex;align-items:center;">
            Import backup
            <input type="file" id="import-file" accept="application/json" class="a11y-hide" />
          </label>
        </div>
      </div>
    </div>`
      : '';

  appEl.innerHTML = `
    <header>
      <h1>Partner Conversation Game</h1>
      <p class="sub">Dice → category → flip the card → pick A–D. Built for two people; use the same room code on each device.</p>
    </header>

    ${!S.room ? renderSetup() : ''}

    ${S.room ? `
    <div class="tabs">
      <button type="button" class="tab ${S.tab === 'play' ? 'active' : ''}" data-tab="play">Play</button>
      <button type="button" class="tab ${S.tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">Compatibility</button>
    </div>
    ${playHtml}
    ${dashboardHtml}
    <div class="panel">
      <p class="sub" style="margin:0;">
        <strong>How it works:</strong> Uses WebRTC for direct peer-to-peer sync between devices (works across different networks!). 
        Both devices must use the <em>exact same room code</em> and be online at the same time. 
        If connection fails, use <strong>Export/Import backup</strong> to manually sync.
      </p>
      <button type="button" class="btn-ghost" id="btn-leave">Leave room</button>
    </div>
    ` : ''}

    <dialog id="legend-dlg" class="legend-dialog"></dialog>
    <footer class="note">Private — runs in your browser. Sync uses WebRTC peer-to-peer (data stays between your devices only).</footer>
  `;

  wire(S.room, q, activeCat);
}

function renderSetup() {
  const params = new URLSearchParams(location.search);
  const prefRoom = params.get('room') || '';
  const roomDefault = (prefRoom || FIXED_ROOM_CODE).slice(0, 40);
  const roomRow = USE_FIXED_ROOM_ONLY
    ? `<p class="sub" style="margin:0 0 .75rem;">Room: <strong>${escapeHtml(FIXED_ROOM_CODE)}</strong> <span class="badge">fixed in app.js</span></p>`
    : `<div class="row">
      <label class="field">Room code (share with partner)
        <input type="text" id="in-room" maxlength="40" placeholder="${escapeHtml(FIXED_ROOM_CODE)}" value="${escapeHtml(roomDefault)}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="next" inputmode="text" />
      </label>
    </div>
    <p class="help-box" style="margin-top:-0.25rem;">Default comes from <code class="code-tag">FIXED_ROOM_CODE</code> in <code class="code-tag">app.js</code>.</p>`;
  return `
  <div class="panel">
    <h2 style="margin:0 0 .75rem;font-size:1rem;">Join a room</h2>
    ${roomRow}
    <div class="row">
      <label class="field">Your name
        <input type="text" id="in-myname" maxlength="40" placeholder="Your first name" />
      </label>
      <label class="field">Partner name (optional)
        <input type="text" id="in-partner" maxlength="40" placeholder="Their first name" />
      </label>
    </div>
    <div class="row">
      <label class="field">You are
        <select id="in-role">
          <option value="">Pick…</option>
          <option value="p1">Player 1</option>
          <option value="p2">Player 2</option>
        </select>
      </label>
    </div>
    <p class="help-box">Agree who is Player 1 vs 2 before you start — each device picks its role.</p>
    <button type="button" class="btn-primary" id="btn-join">Enter room</button>
  </div>`;
}

function wire(hasRoom, q, activeCat) {
  const dlg = document.getElementById('legend-dlg');

  document.querySelectorAll('.cat-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-legend');
      const cat = CATEGORIES.find((c) => c.id === id);
      if (!cat || !dlg) return;
      dlg.innerHTML = `<article><h3>${escapeHtml(cat.emoji)} ${escapeHtml(cat.name)}</h3><p>${escapeHtml(cat.legend)}</p></article><footer><button type="button" class="btn-ghost" id="dlg-close">Close</button></footer>`;
      dlg.showModal();
      document.getElementById('dlg-close')?.addEventListener('click', () => dlg.close());
    });
  });

  document.getElementById('btn-join')?.addEventListener('click', () => {
    const fromInput = document.getElementById('in-room')?.value?.trim();
    const rawRoom = USE_FIXED_ROOM_ONLY ? FIXED_ROOM_CODE : fromInput || FIXED_ROOM_CODE;
    const room = normalizeRoomCode(rawRoom);
    const myName = document.getElementById('in-myname')?.value?.trim();
    const partner = document.getElementById('in-partner')?.value?.trim();
    const role = document.getElementById('in-role')?.value;
    if (!room || !myName || !role) {
      alert('Please enter your name and player role. Use letters/numbers/dashes in the room code.');
      return;
    }
    S.room = room;
    S.myRole = /** @type {Role} */ (role);
    if (role === 'p1') {
      S.p1Name = myName;
      if (partner) S.p2Name = partner;
    } else {
      S.p2Name = myName;
      if (partner) S.p1Name = partner;
    }
    loadPersisted();
    if (role === 'p1' && !S.p1Name) S.p1Name = myName;
    if (role === 'p2' && !S.p2Name) S.p2Name = myName;
    persist();
    localStorage.setItem(`${LS_PREFIX}-role:${S.room}`, role);
    history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(S.room)}`);
    connectYjs();
  });

  document.getElementById('btn-dice')?.addEventListener('click', async () => {
    S.rolling = true;
    render();
    await new Promise((r) => setTimeout(r, 520));
    const d = rollDiceValue();
    applyDice(d);
    S.rolling = false;
    render();
    await new Promise((r) => setTimeout(r, FLIP_AFTER_ROLL_MS));
    S.cardFlipped = true;
    persist();
    render();
  });

  const flip = () => {
    if (!q) return;
    S.cardFlipped = !S.cardFlipped;
    persist();
    render();
  };
  document.getElementById('flip-front')?.addEventListener('click', flip);
  document.getElementById('flip-front')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });

  document.getElementById('btn-another')?.addEventListener('click', async () => {
    if (!S.session.categoryId) return;
    S.session.questionId = pickRandomQuestion(S.session.categoryId);
    S.cardFlipped = false;
    if (ySession && ydoc) {
      ydoc.transact(() => {
        ySession.set('questionId', S.session.questionId);
      });
    } else if (ySession) {
      ySession.set('questionId', S.session.questionId);
    }
    persist();
    render();
    await new Promise((r) => setTimeout(r, FLIP_AFTER_ROLL_MS));
    S.cardFlipped = true;
    persist();
    render();
  });

  document.querySelectorAll('.opt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const role = btn.getAttribute('data-role');
      const i = Number(btn.getAttribute('data-i'));
      if (!q || !activeCat || (role !== 'p1' && role !== 'p2')) return;
      setAnswer(role, activeCat.id, q.id, i);
      render();
    });
  });

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      S.tab = b.getAttribute('data-tab') === 'dashboard' ? 'dashboard' : 'play';
      render();
    });
  });

  document.getElementById('btn-reconnect')?.addEventListener('click', () => {
    connectYjs();
  });

  document.getElementById('btn-leave')?.addEventListener('click', () => {
    disconnectYjs();
    S.room = '';
    S.myRole = '';
    S.syncStatus = 'idle';
    history.replaceState({}, '', location.pathname);
    render();
  });

  document.getElementById('btn-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ ...S, savedAt: Date.now() }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `partner-game-${S.room}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('import-file')?.addEventListener('change', (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result));
        if (d.answers) S.answers = d.answers;
        if (d.session) S.session = { ...S.session, ...d.session };
        if (d.p1Name) S.p1Name = d.p1Name;
        if (d.p2Name) S.p2Name = d.p2Name;
        pushLocalIntoY();
        persist();
        render();
      } catch (e) {
        alert('Invalid backup file');
      }
    };
    r.readAsText(f);
    ev.target.value = '';
  });
}

async function connectYjs() {
  disconnectYjs();
  S.syncStatus = 'connecting';
  render();

  try {
    console.log('[Sync] Loading Yjs libraries...');
    const Y = await import('https://esm.sh/yjs@13.6.18');
    
    ydoc = new Y.Doc();
    const roomId = yjsDocRoomId();
    yAnswers = ydoc.getMap('answers');
    yMeta = ydoc.getMap('meta');
    ySession = ydoc.getMap('session');

    if (USE_WEBRTC) {
      console.log('[Sync] Using WebRTC for peer-to-peer connection (works across different networks!)');
      console.log(`[Sync] Room: ${roomId}`);
      
      const webrtcMod = await import('https://esm.sh/y-webrtc@10.3.0?deps=yjs@13.6.18');
      const WebrtcProvider = webrtcMod.WebrtcProvider || webrtcMod.default?.WebrtcProvider || webrtcMod.default;
      
      if (!WebrtcProvider) throw new Error('WebrtcProvider not found');
      
      provider = new WebrtcProvider(roomId, ydoc, {
        signaling: WEBRTC_SIGNALING,
        password: null,
        awareness: null,
        maxConns: 20,
        filterBcConns: true,
        peerOpts: {}
      });
      
      console.log('[Sync] WebRTC provider created, waiting for peers...');
      
      // WebRTC uses 'peers' and 'synced' events instead of 'status'
      provider.on('peers', (event) => {
        const peerCount = event.added?.length || event.removed?.length || 0;
        console.log(`[Sync] Peers changed. Connected peers: ${provider.room?.peers?.size || 0}`);
        
        if (provider.room?.peers?.size > 0) {
          S.syncStatus = 'synced';
          console.log('[Sync] ✅ Connected to peer(s)!');
        } else {
          console.log('[Sync] ⏳ Waiting for partner to join room...');
        }
        render();
      });
      
      provider.on('synced', (event) => {
        console.log('[Sync] Data synced with peer!');
        mirrorToLocalFromY();
        if (S.myRole === 'p1' && S.p1Name) yMeta.set('p1Name', S.p1Name);
        if (S.myRole === 'p2' && S.p2Name) yMeta.set('p2Name', S.p2Name);
        pushLocalIntoY();
        mirrorToLocalFromY();
        S.syncStatus = 'synced';
        render();
        persist();
      });
      
    } else {
      // Original WebSocket method (fallback)
      console.log(`[Sync] Using WebSocket connection to ${SYNC_URL}`);
      console.log(`[Sync] Room: ${roomId}`);
      
      const mod = await import('https://esm.sh/y-websocket@1.5.0?deps=yjs@13.6.18');
      const WebsocketProvider = mod.WebsocketProvider || mod.default?.WebsocketProvider || mod.default;
      if (!WebsocketProvider) throw new Error('WebsocketProvider not found');
      
      provider = new WebsocketProvider(SYNC_URL, roomId, ydoc);

      provider.on('status', (ev) => {
        console.log(`[Sync] Status changed: ${ev.status}`);
        if (ev.status === 'connected') {
          if (connectSlowTimer) {
            clearTimeout(connectSlowTimer);
            connectSlowTimer = null;
          }
          S.syncStatus = 'synced';
          console.log('[Sync] ✅ Successfully connected!');
        } else if (ev.status === 'disconnected') {
          S.syncStatus = 'offline';
          console.warn('[Sync] ⚠️ Disconnected from server');
        }
        render();
      });

      provider.on('sync', (synced) => {
        console.log(`[Sync] Sync event: ${synced ? 'synced' : 'not synced'}`);
        if (!synced) return;
        mirrorToLocalFromY();
        if (S.myRole === 'p1' && S.p1Name) yMeta.set('p1Name', S.p1Name);
        if (S.myRole === 'p2' && S.p2Name) yMeta.set('p2Name', S.p2Name);
        pushLocalIntoY();
        mirrorToLocalFromY();
        S.syncStatus = 'synced';
        render();
        persist();
      });

      provider.on('connection-error', (err) => {
        console.error('[Sync] Connection error:', err);
      });

      provider.on('connection-close', (ev) => {
        console.warn('[Sync] Connection closed:', ev);
      });
    }

    afterTxn = () => {
      mirrorToLocalFromY();
      persist();
      render();
    };
    ydoc.on('afterTransaction', afterTxn);

    mirrorToLocalFromY();
    if (S.myRole === 'p1' && S.p1Name) yMeta.set('p1Name', S.p1Name);
    if (S.myRole === 'p2' && S.p2Name) yMeta.set('p2Name', S.p2Name);
    pushLocalIntoY();
    mirrorToLocalFromY();
    render();

    connectSlowTimer = setTimeout(() => {
      if (S.syncStatus === 'connecting') {
        console.warn('[Sync] ⏳ Still waiting for partner... Make sure both devices are in the same room.');
        if (!USE_WEBRTC) {
          console.error('[Sync] ❌ Connection timeout - server may be unreachable');
          S.syncStatus = 'offline';
        }
        // For WebRTC, stay in connecting state - peer might join later
        render();
      }
      connectSlowTimer = null;
    }, 15000);
  } catch (e) {
    console.error('[Sync] Error during connection setup:', e);
    S.syncStatus = 'offline';
    disconnectYjs();
    render();
  }
}

function boot() {
  appEl = document.getElementById('app');
  render();
}

document.addEventListener('DOMContentLoaded', boot);
