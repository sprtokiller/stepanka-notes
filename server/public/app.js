'use strict';

/* ── token / auth ──────────────────────────────────────────── */
const TOKEN_KEY = 'stepanka.token';
let token = localStorage.getItem(TOKEN_KEY);
const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let wsConn = null;

async function apiFetch(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Token': token || '', 'X-Client-Id': clientId },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ── login UI ──────────────────────────────────────────────── */
const loginScreen = document.getElementById('login-screen');
const loginInput  = document.getElementById('login-input');
const loginErr    = document.getElementById('login-err');
const loginBtn    = document.getElementById('login-btn');

function showLogin() {
  loginScreen.classList.remove('hidden');
  loginInput.value = '';
  loginErr.textContent = '';
  loginInput.focus();
}

async function tryLogin() {
  const passphrase = loginInput.value;
  loginErr.textContent = '';
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    if (!res.ok) {
      loginInput.classList.add('shake');
      loginErr.textContent = 'ne.';
      loginInput.select();
      setTimeout(() => loginInput.classList.remove('shake'), 450);
      return;
    }
    const { token: t } = await res.json();
    token = t;
    localStorage.setItem(TOKEN_KEY, token);
    loginScreen.classList.add('hidden');
    await loadAndRender();
  } catch {
    loginErr.textContent = 'chyba spojení';
  }
}

loginBtn.addEventListener('click', tryLogin);
loginInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

/* ── state ─────────────────────────────────────────────────── */
const state = { cards: [], connections: [], pan: { x: 0, y: 0 }, scale: 1 };
let sortCounter = 0;
let threadState = null;
let dyingThreads = [];

/* ── DOM refs ──────────────────────────────────────────────── */
const world   = document.getElementById('world');
const empty   = document.getElementById('empty');
const counter = document.getElementById('counter');

/* ── transform ─────────────────────────────────────────────── */
function applyTransform() {
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`;
  drawBackground();
}

/* ── panning (mouse) ───────────────────────────────────────── */
let panState = null;
window.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const t = e.target;
  if (t.closest('.card') || t.closest('.add') || t.closest('.logo') ||
      t.closest('.hint') || t.closest('.counter') || t.closest('#login-screen')) return;
  if (threadState) { threadState = null; return; }
  panState = { sx: e.clientX, sy: e.clientY, ox: state.pan.x, oy: state.pan.y };
  world.classList.add('panning');
  document.body.classList.remove('can-pan');
});
window.addEventListener('mousemove', e => {
  if (!panState) return;
  state.pan.x = panState.ox + (e.clientX - panState.sx);
  state.pan.y = panState.oy + (e.clientY - panState.sy);
  applyTransform();
});
window.addEventListener('mouseup', () => {
  if (!panState) return;
  panState = null;
  world.classList.remove('panning');
});

/* ── zoom (mouse wheel) ────────────────────────────────────── */
window.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const cx = e.clientX, cy = e.clientY;
  const wx = (cx - state.pan.x) / state.scale;
  const wy = (cy - state.pan.y) / state.scale;
  state.scale = Math.max(0.25, Math.min(4, state.scale * factor));
  state.pan.x = cx - wx * state.scale;
  state.pan.y = cy - wy * state.scale;
  applyTransform();
}, { passive: false });

/* ── pan + pinch (touch) ───────────────────────────────────── */
let touchPan   = null;
let pinchState = null;
let cuttingState   = null;
let longPressTimer = null;
let longPressStart = null;
const LONG_PRESS_CANVAS_MS = 350;
const LONG_PRESS_CANCEL_PX = 10;

window.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressStart = null; }
    cuttingState = null;
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const cx   = (t0.clientX + t1.clientX) / 2;
    const cy   = (t0.clientY + t1.clientY) / 2;
    pinchState = { startDist: dist, startScale: state.scale, cx, cy, ox: state.pan.x, oy: state.pan.y };
    touchPan = null;
    return;
  }
  if (e.touches.length !== 1) return;
  const t = e.target;
  if (t.closest('.card') || t.closest('.add') || t.closest('#login-screen')) return;
  const tt = e.touches[0];
  const sx = tt.clientX, sy = tt.clientY;
  touchPan = { sx, sy, ox: state.pan.x, oy: state.pan.y };
  longPressStart = { x: sx, y: sy };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressStart = null;
    touchPan = null;
    cuttingState = { trail: [] };
    navigator.vibrate?.(40);
  }, LONG_PRESS_CANVAS_MS);
}, { passive: true });

window.addEventListener('touchmove', e => {
  if (pinchState && e.touches.length === 2) {
    e.preventDefault();
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const mx   = (t0.clientX + t1.clientX) / 2;
    const my   = (t0.clientY + t1.clientY) / 2;
    const newScale = Math.max(0.25, Math.min(4, pinchState.startScale * dist / pinchState.startDist));
    const wx = (pinchState.cx - pinchState.ox) / pinchState.startScale;
    const wy = (pinchState.cy - pinchState.oy) / pinchState.startScale;
    state.scale = newScale;
    state.pan.x = mx - wx * newScale;
    state.pan.y = my - wy * newScale;
    applyTransform();
    return;
  }
  if (longPressStart && e.touches.length === 1) {
    const tt = e.touches[0];
    if (Math.hypot(tt.clientX - longPressStart.x, tt.clientY - longPressStart.y) > LONG_PRESS_CANCEL_PX) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressStart = null;
    }
  }
  if (cuttingState && e.touches.length === 1) {
    e.preventDefault();
    const tt = e.touches[0];
    const x = tt.clientX, y = tt.clientY;
    cuttingState.trail.push({ x, y });
    for (const conn of [...state.connections]) {
      if (isNearThread(x, y, conn)) cutThread(conn, x, y);
    }
    return;
  }
  if (!touchPan) return;
  const tt = e.touches[0];
  state.pan.x = touchPan.ox + (tt.clientX - touchPan.sx);
  state.pan.y = touchPan.oy + (tt.clientY - touchPan.sy);
  applyTransform();
}, { passive: false });

window.addEventListener('touchend', e => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressStart = null; }
  cuttingState = null;
  if (e.touches.length < 2) pinchState = null;
  if (e.touches.length === 0) touchPan = null;
});

window.addEventListener('touchcancel', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressStart = null; }
  cuttingState = null;
  touchPan = null;
  pinchState = null;
});

window.addEventListener('mousemove', e => {
  const t = e.target;
  const overBg = !(t.closest('.card') || t.closest('.add') || t.closest('.logo') ||
                   t.closest('.hint') || t.closest('.counter') || t.closest('#login-screen'));
  document.body.classList.toggle('can-pan', overBg);
});

/* ── cards ─────────────────────────────────────────────────── */
function isTempId(id) { return typeof id === 'string'; }

function makeCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card entering';
  el.dataset.id = card.id;
  el.style.left = card.x + 'px';
  el.style.top  = card.y + 'px';
  el.style.transform = `rotate(${card.rot || 0}deg)`;
  const CIRC = 56.55;
  el.innerHTML = `
    <div class="txt" data-placeholder="napiš téma…" spellcheck="false"></div>
    <div class="meta">
      <span class="pin" aria-hidden="true"></span>
      <button class="del-x" aria-label="smazat">
        <svg class="del-ring" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="#B83A3A" stroke-width="1.5"
                  stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"
                  stroke-linecap="round" transform="rotate(-90 12 12)"/>
        </svg>
        <span class="del-icon">×</span>
      </button>
    </div>`;

  const txt    = el.querySelector('.txt');
  txt.textContent = card.text || '';

  const delBtn    = el.querySelector('.del-x');
  const delCircle = delBtn.querySelector('circle');
  const HOLD      = 1000;

  delBtn.addEventListener('mousedown', e => {
    e.stopPropagation();
    const start = performance.now();
    let animId;
    let done = false;

    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / HOLD);
      delCircle.style.strokeDashoffset = CIRC * (1 - p);
      if (p < 1) { animId = requestAnimationFrame(tick); }
      else { done = true; }
    };
    animId = requestAnimationFrame(tick);

    const cleanup = (doDelete) => {
      cancelAnimationFrame(animId);
      delCircle.style.strokeDashoffset = CIRC;
      delBtn.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('mouseup', onUp);
      if (doDelete) removeCard(card.id);
    };
    const onLeave = () => cleanup(false);
    const onUp    = () => cleanup(done);

    delBtn.addEventListener('mouseleave', onLeave);
    window.addEventListener('mouseup', onUp);
  });

  let delConfirm = false;
  let delConfirmCancel = null;

  delBtn.addEventListener('touchend', e => {
    e.stopPropagation();
    e.preventDefault();
    if (!delConfirm) {
      delConfirm = true;
      delBtn.classList.add('confirm-delete');
      const cancelConfirm = ev => {
        if (ev.target.closest('.del-x') !== delBtn) {
          delConfirm = false;
          delBtn.classList.remove('confirm-delete');
          document.removeEventListener('touchstart', cancelConfirm, true);
          delConfirmCancel = null;
        }
      };
      delConfirmCancel = cancelConfirm;
      document.addEventListener('touchstart', cancelConfirm, { capture: true, passive: true });
    } else {
      if (delConfirmCancel) {
        document.removeEventListener('touchstart', delConfirmCancel, true);
        delConfirmCancel = null;
      }
      delConfirm = false;
      delBtn.classList.remove('confirm-delete');
      removeCard(card.id);
    }
  }, { passive: false });

  el.addEventListener('dblclick', e => {
    if (e.target.closest('.del-x')) return;
    startEdit(el, card);
  });

  let drag = null;
  el.addEventListener('mousedown', e => {
    if (el.classList.contains('editing')) return;
    if (e.target.closest('.del-x') || e.target.closest('.pin')) return;
    e.stopPropagation();
    if (threadState) {
      if (threadState.fromCardId !== card.id && card.text) createConnection(threadState.fromCardId, card.id);
      threadState = null;
      return;
    }
    drag = { sx: e.clientX, sy: e.clientY, ox: card.x, oy: card.y, moved: false };
    el.classList.add('dragging');
    bringToFront(el, card);
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    card.x = drag.ox + dx / state.scale;
    card.y = drag.oy + dy / state.scale;
    el.style.left = card.x + 'px';
    el.style.top  = card.y + 'px';
    if (wsConn && wsConn.readyState === 1 && !isTempId(card.id)) {
      const now = Date.now();
      if (!drag.lastSent || now - drag.lastSent >= 50) {
        drag.lastSent = now;
        wsConn.send(JSON.stringify({ event: 'card:moved', clientId, id: card.id, x: card.x, y: card.y }));
      }
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    el.classList.remove('dragging');
    if (drag.moved && !isTempId(card.id)) {
      apiFetch('PUT', `/api/cards/${card.id}`, {
        text: card.text, x: card.x, y: card.y, rot: card.rot, sort_order: card.sort_order || 0,
      }).catch(() => {});
    }
    drag = null;
  });

  /* ── touch drag ─────────────────────────────────────────────── */
  let touchDrag    = null;
  let touchPending = null;
  const LONG_PRESS_MS = 350;
  const CANCEL_DIST   = 8;

  const cancelTouchDrag = () => {
    if (touchPending) { clearTimeout(touchPending.timer); touchPending = null; }
    if (touchDrag)    { el.classList.remove('dragging'); touchDrag = null; }
  };

  el.addEventListener('touchstart', e => {
    if (el.classList.contains('editing')) return;
    if (e.target.closest('.del-x') || e.target.closest('.pin')) return;
    if (e.touches.length > 1) { cancelTouchDrag(); return; }
    const touch = e.touches[0];
    const sx = touch.clientX, sy = touch.clientY;
    if (touchPending) clearTimeout(touchPending.timer);
    touchPending = {
      sx, sy,
      timer: setTimeout(() => {
        touchPending = null;
        touchDrag = { ox: card.x, oy: card.y, sx, sy };
        el.classList.add('dragging');
        bringToFront(el, card);
        navigator.vibrate?.(30);
      }, LONG_PRESS_MS),
    };
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (e.touches.length > 1) { cancelTouchDrag(); return; }
    const touch = e.touches[0];
    if (!touch) return;
    if (touchPending) {
      if (Math.hypot(touch.clientX - touchPending.sx, touch.clientY - touchPending.sy) > CANCEL_DIST) {
        clearTimeout(touchPending.timer);
        touchPending = null;
      }
      return;
    }
    if (!touchDrag) return;
    e.preventDefault();
    card.x = touchDrag.ox + (touch.clientX - touchDrag.sx) / state.scale;
    card.y = touchDrag.oy + (touch.clientY - touchDrag.sy) / state.scale;
    el.style.left = card.x + 'px';
    el.style.top  = card.y + 'px';
    if (wsConn && wsConn.readyState === 1 && !isTempId(card.id)) {
      const now = Date.now();
      if (!touchDrag.lastSent || now - touchDrag.lastSent >= 50) {
        touchDrag.lastSent = now;
        wsConn.send(JSON.stringify({ event: 'card:moved', clientId, id: card.id, x: card.x, y: card.y }));
      }
    }
  }, { passive: false });

  el.addEventListener('touchend', () => {
    if (touchPending) { clearTimeout(touchPending.timer); touchPending = null; return; }
    if (!touchDrag) return;
    el.classList.remove('dragging');
    if (!isTempId(card.id)) {
      apiFetch('PUT', `/api/cards/${card.id}`, {
        text: card.text, x: card.x, y: card.y, rot: card.rot, sort_order: card.sort_order || 0,
      }).catch(() => {});
    }
    touchDrag = null;
  });

  el.addEventListener('touchcancel', cancelTouchDrag);

  const pin = el.querySelector('.pin');
  pin.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (!card.text) return;
    e.stopPropagation();
    e.preventDefault();
    if (threadState) {
      if (threadState.fromCardId !== card.id) createConnection(threadState.fromCardId, card.id);
      threadState = null;
    } else {
      threadState = { fromCardId: card.id };
    }
  });

  setTimeout(() => el.classList.remove('entering'), 400);
  return el;
}

function bringToFront(el, card) {
  if (el.parentNode && el.parentNode.lastChild !== el) el.parentNode.appendChild(el);
  const i = state.cards.findIndex(c => c.id === card.id);
  if (i >= 0) { state.cards.splice(i, 1); state.cards.push(card); }
  card.sort_order = ++sortCounter;
}

function startEdit(el, card) {
  el.classList.add('editing');
  const txt = el.querySelector('.txt');
  txt.setAttribute('contenteditable', 'true');
  txt.focus();
  const r = document.createRange();
  r.selectNodeContents(txt); r.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);

  const finish = async (commit) => {
    txt.removeAttribute('contenteditable');
    el.classList.remove('editing');
    txt.removeEventListener('blur', onBlur);
    txt.removeEventListener('keydown', onKey);

    if (commit) {
      const v = txt.textContent.trim();
      if (!v) { removeCard(card.id); return; }
      card.text = v;
      txt.textContent = v;
      if (isTempId(card.id)) {
        try {
          const { id } = await apiFetch('POST', '/api/cards', {
            text: card.text, x: card.x, y: card.y, rot: card.rot, sort_order: card.sort_order || 0,
          });
          card.id = id;
          el.dataset.id = id;
        } catch { /* stay local if offline */ }
      } else {
        apiFetch('PUT', `/api/cards/${card.id}`, {
          text: card.text, x: card.x, y: card.y, rot: card.rot, sort_order: card.sort_order || 0,
        }).catch(() => {});
      }
    } else {
      txt.textContent = card.text || '';
      if (isTempId(card.id)) removeCard(card.id);
    }
  };

  const onBlur  = () => finish(true);
  const onKey   = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape')          { e.preventDefault(); finish(false); }
  };
  txt.addEventListener('blur', onBlur);
  txt.addEventListener('keydown', onKey);
}

function removeCardLocal(id) {
  const i = state.cards.findIndex(c => c.id === id);
  if (i < 0) return;
  state.cards.splice(i, 1);
  state.connections = state.connections.filter(c => c.from_id !== id && c.to_id !== id);
  const el = world.querySelector(`.card[data-id="${id}"]`);
  if (el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 240); }
  refreshEmpty();
}

function removeCard(id) {
  removeCardLocal(id);
  if (!isTempId(id)) apiFetch('DELETE', `/api/cards/${id}`).catch(() => {});
}

function refreshEmpty() {
  empty.classList.toggle('hidden', state.cards.length > 0);
  counter.innerHTML = `<b>${state.cards.length}</b> ${plural(state.cards.length)}`;
}
function plural(n) {
  if (n === 1) return 'téma';
  if (n >= 2 && n <= 4) return 'témata';
  return 'témat';
}

function clusterPos() {
  const cx = (window.innerWidth  / 2 - state.pan.x) / state.scale;
  const cy = (window.innerHeight / 2 - state.pan.y) / state.scale;
  const n = state.cards.length;
  const angle = n * 2.39996;
  const radius = 30 + Math.sqrt(n) * 70;
  return {
    x:   cx + Math.cos(angle) * radius + (Math.random() - .5) * 30 - 110,
    y:   cy + Math.sin(angle) * radius + (Math.random() - .5) * 30 - 40,
    rot: (Math.random() - .5) * 3.6,
  };
}

function panToCard(card) {
  state.pan.x = window.innerWidth  / 2 - (card.x + 115) * state.scale;
  state.pan.y = window.innerHeight / 2 - (card.y + 45)  * state.scale;
  applyTransform();
}

function addCard() {
  const pos = clusterPos();
  const card = { id: `new_${Date.now()}`, text: '', x: pos.x, y: pos.y, rot: pos.rot, sort_order: 0 };
  state.cards.push(card);
  const el = makeCardEl(card);
  world.appendChild(el);
  startEdit(el, card);
  refreshEmpty();
}

document.getElementById('add').addEventListener('click', () => {
  if (!token) return;
  addCard();
});

function renderAll() {
  world.innerHTML = '';
  for (const c of state.cards) world.appendChild(makeCardEl(c));
}

/* ── background canvas ─────────────────────────────────────── */
const bgCanvas = document.getElementById('bg');
const bgCtx    = bgCanvas.getContext('2d');
const fgCanvas = document.getElementById('fg');
const fgCtx    = fgCanvas.getContext('2d');
let DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

function resizeBg() {
  DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  for (const [cv, cx] of [[bgCanvas, bgCtx], [fgCanvas, fgCtx]]) {
    cv.width  = innerWidth * DPR;
    cv.height = innerHeight * DPR;
    cv.style.width  = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  drawBackground();
}
window.addEventListener('resize', resizeBg);

const TILE = 220;

function drawBackground() {
  const W = innerWidth, H = innerHeight;
  const sc = state.scale;
  bgCtx.clearRect(0, 0, W, H);
  bgCtx.save();
  bgCtx.translate(state.pan.x, state.pan.y);
  bgCtx.scale(sc, sc);

  const worldX0  = -state.pan.x / sc;
  const worldY0  = -state.pan.y / sc;
  const cols     = Math.ceil(W / (TILE * sc)) + 3;
  const rows     = Math.ceil(H / (TILE * sc)) + 3;
  const startCol = Math.floor(worldX0 / TILE) - 1;
  const startRow = Math.floor(worldY0 / TILE) - 1;

  const nodes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gc = startCol + c, gr = startRow + r;
      const j  = hash2(gc, gr);
      const jx = (j % 97 - 48) / 48 * 28;
      const jy = ((j >> 3) % 97 - 48) / 48 * 28;
      nodes.push({ x: gc * TILE + jx, y: gr * TILE + jy, h: j });
    }
  }

  bgCtx.strokeStyle = 'rgba(200,180,140,0.22)';
  bgCtx.lineWidth = 0.7 / sc;
  const idx = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = nodes[idx(c, r)];
      if (c + 1 < cols && (a.h & 7) > 2)
        bgLine(a.x, a.y, nodes[idx(c + 1, r)].x, nodes[idx(c + 1, r)].y);
      if (r + 1 < rows && ((a.h >> 4) & 7) > 2)
        bgLine(a.x, a.y, nodes[idx(c, r + 1)].x, nodes[idx(c, r + 1)].y);
      if (c + 1 < cols && r + 1 < rows && ((a.h >> 8) & 15) > 12) {
        bgCtx.save(); bgCtx.globalAlpha = 0.5;
        bgLine(a.x, a.y, nodes[idx(c + 1, r + 1)].x, nodes[idx(c + 1, r + 1)].y);
        bgCtx.restore();
      }
    }
  }

  for (const n of nodes) {
    const red = (n.h & 31) === 0;
    bgCtx.beginPath();
    bgCtx.fillStyle = red ? 'rgba(184,58,58,0.55)' : 'rgba(170,148,108,0.55)';
    bgCtx.arc(n.x, n.y, (red ? 2.3 : 1.4) / sc, 0, Math.PI * 2);
    bgCtx.fill();
  }

  bgCtx.restore();
}

function bgLine(x1, y1, x2, y2) {
  bgCtx.beginPath(); bgCtx.moveTo(x1, y1); bgCtx.lineTo(x2, y2); bgCtx.stroke();
}

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

/* ── cursor tracking ───────────────────────────────────────── */
let lastCursor = { x: -9999, y: -9999 };
window.addEventListener('mousemove', e => { lastCursor = { x: e.clientX, y: e.clientY }; });
window.addEventListener('mouseleave', () => { lastCursor = { x: -9999, y: -9999 }; });

/* ── threads (red string connections) ─────────────────────── */
function getPinScreenPos(cardId) {
  const pin = world.querySelector(`.card[data-id="${cardId}"] .pin`);
  if (!pin) return null;
  const r = pin.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function threadCP(x1, y1, x2, y2) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const sag  = Math.min(dist * 0.3, 100) + 15;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 + sag };
}

function drawSaggyThread(x1, y1, x2, y2, alpha) {
  const cp = threadCP(x1, y1, x2, y2);
  fgCtx.save();
  if (alpha !== undefined) fgCtx.globalAlpha = alpha;
  fgCtx.strokeStyle = '#B83A3A';
  fgCtx.lineWidth = 1.5;
  fgCtx.lineCap = 'round';
  fgCtx.beginPath();
  fgCtx.moveTo(x1, y1);
  fgCtx.quadraticCurveTo(cp.x, cp.y, x2, y2);
  fgCtx.stroke();
  fgCtx.restore();
}

function isNearThread(mx, my, conn) {
  const p1 = getPinScreenPos(conn.from_id);
  const p2 = getPinScreenPos(conn.to_id);
  if (!p1 || !p2) return false;
  const cp = threadCP(p1.x, p1.y, p2.x, p2.y);
  for (let i = 0; i <= 30; i++) {
    const t = i / 30, mt = 1 - t;
    const bx = mt*mt*p1.x + 2*mt*t*cp.x + t*t*p2.x;
    const by = mt*mt*p1.y + 2*mt*t*cp.y + t*t*p2.y;
    if (Math.hypot(mx - bx, my - by) < 8) return true;
  }
  return false;
}

const THREAD_G    = 3000;
const THREAD_DAMP = 0.9;
const THREAD_DUR  = 2000;

function drawThreads() {
  const now = performance.now();
  fgCtx.clearRect(0, 0, innerWidth, innerHeight);

  for (const conn of state.connections) {
    const p1 = getPinScreenPos(conn.from_id);
    const p2 = getPinScreenPos(conn.to_id);
    if (p1 && p2) drawSaggyThread(p1.x, p1.y, p2.x, p2.y);
  }

  if (threadState && lastCursor.x > -1000) {
    const p1 = getPinScreenPos(threadState.fromCardId);
    if (p1) drawSaggyThread(p1.x, p1.y, lastCursor.x, lastCursor.y, 0.55);
  }

  for (let i = dyingThreads.length - 1; i >= 0; i--) {
    const d = dyingThreads[i];
    const elapsed = now - d.startTime;
    if (elapsed >= THREAD_DUR) { dyingThreads.splice(i, 1); continue; }

    const dt = Math.min((now - d.lastTime) / 1000, 0.05);
    d.lastTime = now;

    for (const end of [d.end1, d.end2]) {
      const angAcc = -(THREAD_G / end.L) * Math.sin(end.theta) - THREAD_DAMP * end.omega;
      end.omega += angAcc * dt;
      end.theta += end.omega * dt;
    }

    const t = elapsed / THREAD_DUR;
    const fade = t < 0.75 ? 0.88 : (1 - (t - 0.75) / 0.25) * 0.88;

    for (const end of [d.end1, d.end2]) {
      const freeX = end.pivotX + end.L * Math.sin(end.theta);
      const freeY = end.pivotY + end.L * Math.cos(end.theta);
      drawSaggyThread(end.pivotX, end.pivotY, freeX, freeY, fade);
    }
  }

  if (cuttingState && cuttingState.trail.length > 1) {
    fgCtx.save();
    fgCtx.strokeStyle = 'rgba(184,58,58,0.8)';
    fgCtx.lineWidth = 2.5;
    fgCtx.lineCap = 'round';
    fgCtx.lineJoin = 'round';
    fgCtx.beginPath();
    fgCtx.moveTo(cuttingState.trail[0].x, cuttingState.trail[0].y);
    for (let i = 1; i < cuttingState.trail.length; i++) {
      fgCtx.lineTo(cuttingState.trail[i].x, cuttingState.trail[i].y);
    }
    fgCtx.stroke();
    fgCtx.restore();
  }
}

function createConnection(fromId, toId) {
  if (fromId === toId || isTempId(fromId) || isTempId(toId)) return;
  if (state.connections.some(c =>
    (c.from_id === fromId && c.to_id === toId) ||
    (c.from_id === toId   && c.to_id === fromId)
  )) return;
  const conn = { id: null, from_id: fromId, to_id: toId };
  state.connections.push(conn);
  apiFetch('POST', '/api/connections', { from_id: fromId, to_id: toId })
    .then(({ id }) => { conn.id = id; })
    .catch(() => {
      const i = state.connections.indexOf(conn);
      if (i >= 0) state.connections.splice(i, 1);
    });
}

function makePendulumEnd(pivot, cx, cy) {
  const dx = cx - pivot.x, dy = cy - pivot.y;
  const L = Math.max(Math.hypot(dx, dy), 1);
  return { pivotX: pivot.x, pivotY: pivot.y, L, theta: Math.atan2(dx, dy), omega: 0 };
}

function cutThreadLocal(conn, cutX, cutY) {
  const i = state.connections.indexOf(conn);
  if (i < 0) return;
  state.connections.splice(i, 1);
  const p1 = getPinScreenPos(conn.from_id);
  const p2 = getPinScreenPos(conn.to_id);
  if (p1 && p2) {
    const now = performance.now();
    dyingThreads.push({
      end1: makePendulumEnd(p1, cutX, cutY),
      end2: makePendulumEnd(p2, cutX, cutY),
      startTime: now, lastTime: now,
    });
  }
}

function cutThread(conn, cutX, cutY) {
  cutThreadLocal(conn, cutX, cutY);
  if (conn.id !== null) apiFetch('DELETE', `/api/connections/${conn.id}`, { cutX, cutY }).catch(() => {});
}

window.addEventListener('dblclick', e => {
  if (!token) return;
  const t = e.target;
  if (t.closest('.card') || t.closest('.add') || t.closest('.logo') ||
      t.closest('.hint') || t.closest('.counter') || t.closest('#login-screen')) return;
  threadState = null;
  const wx = (e.clientX - state.pan.x) / state.scale - 115;
  const wy = (e.clientY - state.pan.y) / state.scale - 45;
  const card = { id: `new_${Date.now()}`, text: '', x: wx, y: wy, rot: (Math.random() - .5) * 3.6, sort_order: 0 };
  state.cards.push(card);
  const el = makeCardEl(card);
  world.appendChild(el);
  startEdit(el, card);
  refreshEmpty();
});

window.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (threadState) { threadState = null; return; }
  const mx = e.clientX, my = e.clientY;
  for (const conn of state.connections) {
    if (isNearThread(mx, my, conn)) { cutThread(conn, mx, my); return; }
  }
});

/* ── animation loop ────────────────────────────────────────── */
function loop() { drawBackground(); drawThreads(); requestAnimationFrame(loop); }

/* ── center viewport on all cards ──────────────────────────── */
function centerOnCards() {
  if (!state.cards.length) {
    state.pan = { x: 0, y: 0 };
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of state.cards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + 230);
    maxY = Math.max(maxY, c.y + 90);
  }
  const W = window.innerWidth, H = window.innerHeight;
  const PAD = 60;
  const scaleToFit = Math.min(
    (W - PAD * 2) / (maxX - minX),
    (H - PAD * 2) / (maxY - minY),
    1,
  );
  state.scale = Math.max(0.25, scaleToFit);
  state.pan = {
    x: W / 2 - (minX + maxX) / 2 * state.scale,
    y: H / 2 - (minY + maxY) / 2 * state.scale,
  };
}

/* ── load state and render ─────────────────────────────────── */
async function loadAndRender() {
  const data = await apiFetch('GET', '/api/state');
  if (data.meta) {
    document.querySelector('.logo-name-a').textContent = data.meta.nameA;
    document.querySelector('.logo-name-b').textContent = data.meta.nameB;
    document.querySelector('.logo-sub').textContent    = data.meta.sub;
  }
  state.cards = data.cards;
  state.connections = data.connections || [];
  sortCounter = state.cards.reduce((m, c) => Math.max(m, c.sort_order || 0), 0);
  centerOnCards();
  applyTransform();
  renderAll();
  refreshEmpty();
  connectWS();
}

/* ── WebSocket real-time sync ──────────────────────────────── */
function connectWS() {
  if (!token) return;
  if (wsConn && wsConn.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  wsConn = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  wsConn.addEventListener('message', e => {
    try { handleWSMessage(JSON.parse(e.data)); } catch {}
  });
  wsConn.addEventListener('close', () => {
    wsConn = null;
    if (token) setTimeout(connectWS, 3000);
  });
  wsConn.addEventListener('error', () => {});
}

function handleWSMessage(msg) {
  if (msg.clientId === clientId) return;

  switch (msg.event) {
    case 'card:created': {
      if (state.cards.find(c => c.id === msg.id)) break;
      const card = { id: msg.id, text: msg.text, x: msg.x, y: msg.y, rot: msg.rot, sort_order: msg.sort_order };
      state.cards.push(card);
      sortCounter = Math.max(sortCounter, msg.sort_order || 0);
      world.appendChild(makeCardEl(card));
      refreshEmpty();
      break;
    }
    case 'card:updated': {
      const card = state.cards.find(c => c.id === msg.id);
      if (!card) break;
      const el = world.querySelector(`.card[data-id="${msg.id}"]`);
      const busy = el && (el.classList.contains('editing') || el.classList.contains('dragging'));
      card.x = msg.x; card.y = msg.y; card.rot = msg.rot; card.sort_order = msg.sort_order;
      sortCounter = Math.max(sortCounter, msg.sort_order || 0);
      if (!busy) {
        card.text = msg.text;
        if (el) {
          el.querySelector('.txt').textContent = msg.text;
          el.style.left = msg.x + 'px';
          el.style.top  = msg.y + 'px';
          el.style.transform = `rotate(${msg.rot || 0}deg)`;
        }
      }
      break;
    }
    case 'card:deleted':
      removeCardLocal(msg.id);
      break;
    case 'connection:created': {
      if (state.connections.some(c => c.id === msg.id ||
          (c.from_id === msg.from_id && c.to_id === msg.to_id))) break;
      state.connections.push({ id: msg.id, from_id: msg.from_id, to_id: msg.to_id });
      break;
    }
    case 'card:moved': {
      const card = state.cards.find(c => c.id === msg.id);
      if (!card) break;
      card.x = msg.x; card.y = msg.y;
      const el = world.querySelector(`.card[data-id="${msg.id}"]`);
      if (el && !el.classList.contains('dragging')) {
        el.style.left = msg.x + 'px';
        el.style.top  = msg.y + 'px';
      }
      break;
    }
    case 'connection:deleted': {
      const conn = state.connections.find(c => c.id === msg.id);
      if (!conn) break;
      const p1 = getPinScreenPos(conn.from_id);
      const p2 = getPinScreenPos(conn.to_id);
      const cutX = p1 && p2 ? (p1.x + p2.x) / 2 : msg.cutX;
      const cutY = p1 && p2 ? (p1.y + p2.y) / 2 : msg.cutY;
      cutThreadLocal(conn, cutX, cutY);
      break;
    }
  }
}

/* ── boot ──────────────────────────────────────────────────── */
async function boot() {
  resizeBg();
  requestAnimationFrame(loop);

  if (!token) { showLogin(); return; }

  try {
    await loadAndRender();
  } catch (e) {
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    showLogin();
  }
}

boot();
