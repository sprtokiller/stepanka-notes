'use strict';
const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto  = require('crypto');
const path    = require('path');

const PORT       = process.env.PORT || 3000;
const DB_PATH    = process.env.DB_PATH || '/app/data/stepanka.db';
const PASSPHRASE = 'chrochtající palačinka';

const app    = express();
const db     = new Database(DB_PATH);
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL DEFAULT '',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    rot REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS pan (
    id INTEGER PRIMARY KEY DEFAULT 1,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO pan (id, x, y) VALUES (1, 0, 0);
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    to_id   INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    UNIQUE(from_id, to_id)
  );
`);

/* ── WebSocket hub ─────────────────────────────────────────── */
const clients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const tkn = url.searchParams.get('token');
  if (!db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(tkn)) {
    ws.close(4001, 'unauthorized');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'card:moved') {
        const out = JSON.stringify({ event: 'card:moved', clientId: msg.clientId, id: msg.id, x: msg.x, y: msg.y });
        for (const client of clients) {
          if (client !== ws && client.readyState === 1) client.send(out);
        }
      }
    } catch {}
  });
});

setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/* ── Express middleware ─────────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  if (!db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token))
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* ── API ────────────────────────────────────────────────────── */
app.post('/api/auth', (req, res) => {
  const { passphrase } = req.body || {};
  if (typeof passphrase !== 'string' || passphrase.trim() !== PASSPHRASE) {
    return res.status(403).json({ error: 'špatné heslo' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  res.json({ token });
});

app.get('/api/state', requireAuth, (req, res) => {
  const cards = db.prepare(
    'SELECT id, text, x, y, rot, sort_order FROM cards ORDER BY sort_order ASC, id ASC'
  ).all();
  const pan = db.prepare('SELECT x, y FROM pan WHERE id = 1').get();
  const connections = db.prepare('SELECT id, from_id, to_id FROM connections').all();
  res.json({ cards, pan: pan || { x: 0, y: 0 }, connections, meta: { nameA: 'Štěpánka', nameB: 'Víťa', sub: 'místo na slova mezi námi' } });
});

app.post('/api/cards', requireAuth, (req, res) => {
  const { text = '', x = 0, y = 0, rot = 0, sort_order = 0 } = req.body || {};
  const result = db.prepare(
    'INSERT INTO cards (text, x, y, rot, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(text, x, y, rot, sort_order);
  const id = result.lastInsertRowid;
  broadcast({ event: 'card:created', clientId: req.headers['x-client-id'] || '', id, text, x, y, rot, sort_order });
  res.json({ id });
});

app.put('/api/cards/:id', requireAuth, (req, res) => {
  const { text = '', x = 0, y = 0, rot = 0, sort_order = 0 } = req.body || {};
  const id = Number(req.params.id);
  db.prepare(
    'UPDATE cards SET text=?, x=?, y=?, rot=?, sort_order=? WHERE id=?'
  ).run(text, x, y, rot, sort_order, id);
  broadcast({ event: 'card:updated', clientId: req.headers['x-client-id'] || '', id, text, x, y, rot, sort_order });
  res.json({ ok: true });
});

app.delete('/api/cards/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM cards WHERE id=?').run(id);
  broadcast({ event: 'card:deleted', clientId: req.headers['x-client-id'] || '', id });
  res.json({ ok: true });
});

app.post('/api/connections', requireAuth, (req, res) => {
  const { from_id, to_id } = req.body || {};
  if (!from_id || !to_id || from_id === to_id) return res.status(400).json({ error: 'invalid' });
  try {
    const result = db.prepare(
      'INSERT INTO connections (from_id, to_id) VALUES (?, ?)'
    ).run(from_id, to_id);
    const id = result.lastInsertRowid;
    broadcast({ event: 'connection:created', clientId: req.headers['x-client-id'] || '', id, from_id, to_id });
    res.json({ id });
  } catch {
    res.status(409).json({ error: 'exists' });
  }
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { cutX = 0, cutY = 0 } = req.body || {};
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  broadcast({ event: 'connection:deleted', clientId: req.headers['x-client-id'] || '', id, cutX, cutY });
  res.json({ ok: true });
});

app.put('/api/pan', requireAuth, (req, res) => {
  const { x = 0, y = 0 } = req.body || {};
  db.prepare('UPDATE pan SET x=?, y=? WHERE id=1').run(x, y);
  res.json({ ok: true });
});

server.listen(PORT, () => console.log(`Štěpánka běží na :${PORT}`));
