#!/usr/bin/env node
// Corral server — serves index.html + /api/agents (live lasso status)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3377;
const SESSIONS_FILE = process.env.LASSO_SESSIONS || path.join(process.env.HOME, 'clawd/lasso/sessions.json');
const ONE_HOUR_MS = 60 * 60 * 1000;
const TOKEN_CACHE_TTL_MS = 10 * 1000;
const TOKEN_DIRS = ['.codex', '.claude'];
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

const tokenCache = new Map();

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
  const pid = normalizePid(session.agentPid || session.pid);
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

function getWorkspacePath(session) {
  if (!session) return null;
  const candidates = [
    session.workspacePath,
    session.workspace_path,
    session.workspace,
    session.workingDir,
    session.workdir,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function sumTokenObject(obj, includeAllNumbers) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  const keys = Object.keys(obj);
  const totalKey = keys.find((key) => /token/i.test(key) && /total/i.test(key));
  if (totalKey) {
    const total = coerceNumber(obj[totalKey]);
    if (total !== null) return total;
  }

  let sum = 0;
  let matched = false;
  for (const [key, value] of Object.entries(obj)) {
    const num = coerceNumber(value);
    if (num === null) continue;
    if (/token/i.test(key)) {
      sum += num;
      matched = true;
    } else if (includeAllNumbers) {
      sum += num;
    }
  }
  if (!matched && !includeAllNumbers) return 0;
  return sum;
}

function sumTokenValue(value, includeAllNumbers) {
  const numeric = coerceNumber(value);
  if (numeric !== null) return numeric;
  if (value && typeof value === 'object') return sumTokenObject(value, includeAllNumbers);
  return 0;
}

function extractTokensFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (entry.usage !== undefined) return sumTokenValue(entry.usage, false);
  if (entry.tokens !== undefined) return sumTokenValue(entry.tokens, true);
  return 0;
}

async function parseJsonlTokens(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    return null;
  }
  if (!raw.trim()) return 0;
  let total = 0;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      total += extractTokensFromEntry(entry);
    } catch (err) {
      // ignore malformed JSONL lines
    }
  }
  return total;
}

async function getTokensForWorkspace(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  const now = Date.now();
  const cached = tokenCache.get(workspacePath);
  if (cached && now - cached.ts < TOKEN_CACHE_TTL_MS) return cached.tokensUsed;

  let total = 0;
  let foundAny = false;
  for (const dirName of TOKEN_DIRS) {
    const dirPath = path.join(workspacePath, dirName);
    let entries = [];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      const tokens = await parseJsonlTokens(filePath);
      if (tokens === null) continue;
      total += tokens;
      foundAny = true;
    }
  }

  const tokensUsed = foundAny ? total : null;
  tokenCache.set(workspacePath, { tokensUsed, ts: now });
  return tokensUsed;
}

async function getLassoStatus() {
  let raw;
  try {
    raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
  } catch (err) {
    return { sessions: [] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw err;
  }

  // sessions.json has { sessions: { id: {...}, id: {...} } } — flatten to array
  const obj = data.sessions || {};
  const list = Object.entries(obj).map(([id, s]) => ({ id, ...s }));
  const now = Date.now();
  const overlayed = list.map((session) => applyLivenessOverlay(session, now));
  const withTokens = await Promise.all(
    overlayed.map(async (session) => {
      const workspacePath = getWorkspacePath(session);
      const tokensUsed = await getTokensForWorkspace(workspacePath);
      return { ...session, tokensUsed };
    }),
  );
  return { sessions: withTokens };
}

const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/agents') {
    getLassoStatus()
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, sessions: [] }));
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

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🤠 Corral running at http://${HOST}:${PORT}`);
});
