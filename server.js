#!/usr/bin/env node
// Corral server — serves index.html + /api/agents (live lasso status)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3377;
const SESSIONS_FILE = process.env.LASSO_SESSIONS || path.join(process.env.HOME, 'clawd/lasso/sessions.json');
const ONE_HOUR_MS = 60 * 60 * 1000;
const LAST_SEEN_KEYS = [
  'lastSeenAlive',
  'last_seen_alive',
  'lastSeen',
  'last_seen',
  'lastHeartbeat',
  'last_heartbeat',
  'lastActivityAt',
  'last_activity_at',
  'lastActiveAt',
  'last_active_at',
  'activityAt',
  'activity_at',
  'updatedAt',
  'updated_at',
  'lastUpdate',
  'last_update',
];

function normalizePid(pid) {
  if (Number.isInteger(pid) && pid > 0) return pid;
  if (typeof pid === 'string') {
    const value = Number(pid);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return true;
  }
}

function coerceTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return coerceTimestamp(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function pickLastSeenAlive(session) {
  for (const key of LAST_SEEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(session, key)) {
      const ts = coerceTimestamp(session[key]);
      if (ts) return ts;
    }
  }
  return null;
}

function applyLivenessOverlay(session, now) {
  const pid = normalizePid(session.pid);
  const lastSeen = pickLastSeenAlive(session);
  const lastSeenAlive = lastSeen ? new Date(lastSeen).toISOString() : null;

  if (!pid) {
    return { ...session, lastSeenAlive };
  }

  if (isPidAlive(pid)) {
    return { ...session, lastSeenAlive: new Date(now).toISOString() };
  }

  let status = session.status;
  let activity = session.activity;
  const statusLower = (status || '').toLowerCase();
  if (statusLower.includes('working')) {
    status = 'exited';
    activity = 'exited';
  }

  if (lastSeen && now - lastSeen > ONE_HOUR_MS) {
    status = 'archived';
    activity = 'archived';
  }

  return { ...session, status, activity, lastSeenAlive };
}

function getLassoStatus(cb) {
  fs.readFile(SESSIONS_FILE, 'utf8', (err, raw) => {
    if (err) return cb(null, { sessions: [] });
    try {
      const data = JSON.parse(raw);
      // sessions.json has { sessions: { id: {...}, id: {...} } } — flatten to array
      const obj = data.sessions || {};
      const list = Object.entries(obj).map(([id, s]) => ({ id, ...s }));
      const now = Date.now();
      const overlayed = list.map((session) => applyLivenessOverlay(session, now));
      cb(null, { sessions: overlayed });
    } catch (e) {
      cb(e, null);
    }
  });
}

const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/agents') {
    getLassoStatus((err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, sessions: [] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain', 'Cache-Control': 'no-cache, no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🤠 Corral running at http://localhost:${PORT}`);
});
