'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/app/data/stepanka.db';
const PASSPHRASE = 'chrochtající palačinka';

const app = express();
const db = new Database(DB_PATH);

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const row = db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'unauthorized' });
  next();
}

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
  res.json({ cards, pan: pan || { x: 0, y: 0 }, connections });
});

app.post('/api/cards', requireAuth, (req, res) => {
  const { text = '', x = 0, y = 0, rot = 0, sort_order = 0 } = req.body || {};
  const result = db.prepare(
    'INSERT INTO cards (text, x, y, rot, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(text, x, y, rot, sort_order);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/cards/:id', requireAuth, (req, res) => {
  const { text = '', x = 0, y = 0, rot = 0, sort_order = 0 } = req.body || {};
  db.prepare(
    'UPDATE cards SET text=?, x=?, y=?, rot=?, sort_order=? WHERE id=?'
  ).run(text, x, y, rot, sort_order, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/cards/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cards WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/connections', requireAuth, (req, res) => {
  const { from_id, to_id } = req.body || {};
  if (!from_id || !to_id || from_id === to_id) return res.status(400).json({ error: 'invalid' });
  try {
    const result = db.prepare(
      'INSERT INTO connections (from_id, to_id) VALUES (?, ?)'
    ).run(from_id, to_id);
    res.json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'exists' });
  }
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM connections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/pan', requireAuth, (req, res) => {
  const { x = 0, y = 0 } = req.body || {};
  db.prepare('UPDATE pan SET x=?, y=? WHERE id=1').run(x, y);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Štěpánka běží na :${PORT}`));
