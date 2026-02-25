#!/usr/bin/env node
// Corral server — serves index.html + /api/agents (live lasso status)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3377;
const SESSIONS_FILE = process.env.LASSO_SESSIONS || path.join(process.env.HOME, 'clawd/lasso/sessions.json');
const HISTORY_FILE = process.env.LASSO_HISTORY || path.join(path.dirname(SESSIONS_FILE), 'history.json');
const ONE_HOUR_MS = 60 * 60 * 1000;
const TOKEN_CACHE_TTL_MS = 10 * 1000;
const TOKEN_DIRS = ['.codex', '.claude'];
const HISTORY_MAX_ENTRIES = 50;
const HISTORY_COMPLETED_MAX = 20;
const HISTORY_STATUS_LIMIT = 20;
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
const CREATED_AT_KEYS = [
  'createdAt',
  'created_at',
  'startedAt',
  'started_at',
  'startTime',
  'start_time',
  'spawnedAt',
  'spawned_at',
];
const UPDATED_AT_KEYS = ['updatedAt', 'updated_at', ...LAST_SEEN_KEYS];
const ENDED_AT_KEYS = [
  'endedAt',
  'ended_at',
  'completedAt',
  'completed_at',
  'finishedAt',
  'finished_at',
  'closedAt',
  'closed_at',
  'mergedAt',
  'merged_at',
  'stoppedAt',
  'stopped_at',
  'deadAt',
  'dead_at',
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

function pickSessionTimestamp(session, keys) {
  if (!session || typeof session !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(session, key)) {
      const ts = coerceTimestamp(session[key]);
      if (ts) return ts;
    }
  }
  return null;
}

function toIsoString(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toISOString();
  } catch (err) {
    return null;
  }
}

function normalizeHistoryEntry(entry) {
  const next = { ...entry };
  if (!Array.isArray(next.statusHistory)) next.statusHistory = [];
  const createdTs = coerceTimestamp(next.createdAt);
  if (createdTs) next.createdAt = new Date(createdTs).toISOString();
  const endedTs = coerceTimestamp(next.endedAt);
  if (endedTs) next.endedAt = new Date(endedTs).toISOString();
  return next;
}

function recordStatusTransition(entry, status, activity, at) {
  const history = Array.isArray(entry.statusHistory) ? entry.statusHistory : [];
  const last = history[history.length - 1];
  const nextStatus = status || '';
  const nextActivity = activity || '';
  if (!last || last.status !== nextStatus || last.activity !== nextActivity) {
    const isoAt = toIsoString(at);
    if (isoAt) {
      history.push({ status: nextStatus, activity: nextActivity, at: isoAt });
      if (history.length > HISTORY_STATUS_LIMIT) {
        history.splice(0, history.length - HISTORY_STATUS_LIMIT);
      }
    }
  }
  entry.statusHistory = history;
}

function isCompletedStatus(status, activity) {
  const s = (status || '').toLowerCase();
  const a = (activity || '').toLowerCase();
  return (
    s.includes('merged') ||
    s.includes('dead') ||
    s.includes('exited') ||
    s.includes('archived') ||
    a.includes('merged') ||
    a.includes('dead') ||
    a.includes('exited') ||
    a.includes('archived')
  );
}

function buildHistorySnapshot(session, now) {
  const createdAtTs = pickSessionTimestamp(session, CREATED_AT_KEYS) || now;
  const updatedAtTs = pickSessionTimestamp(session, UPDATED_AT_KEYS) || now;
  const endedAtTs = pickSessionTimestamp(session, ENDED_AT_KEYS);
  const status = session.status || session.activity || '';
  const activity = session.activity || '';
  const snapshot = {
    id: session.id || session.sessionId || session.agentId || session.name,
    repo: session.repo || session.repository || session.repoName || session.repo_name,
    issueId: session.issueId || session.issue_id || session.issueNumber || session.issue_number,
    issueTitle: session.issueTitle || session.issue_title || session.title,
    status,
    agentType: session.agentType || session.agent_type || session.agent || session.provider,
    createdAt: toIsoString(createdAtTs) || new Date(now).toISOString(),
    endedAt: toIsoString(endedAtTs),
    prNumber: session.prNumber || session.pr_number || session.pr,
    activity,
    lastUpdatedAt: toIsoString(updatedAtTs) || new Date(now).toISOString(),
  };
  return snapshot;
}

async function readHistoryFile() {
  let raw;
  try {
    raw = await fs.promises.readFile(HISTORY_FILE, 'utf8');
  } catch (err) {
    return [];
  }
  if (!raw.trim()) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.history)) return data.history;
    return [];
  } catch (err) {
    return [];
  }
}

async function writeHistoryFile(entries) {
  await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

async function updateHistoryFromSessions(sessions) {
  const now = Date.now();
  const history = await readHistoryFile();
  const historyById = new Map();
  history.forEach((entry) => {
    if (!entry || !entry.id) return;
    historyById.set(entry.id, normalizeHistoryEntry(entry));
  });

  const liveIds = new Set();
  sessions.forEach((session) => {
    if (!session) return;
    const snapshot = buildHistorySnapshot(session, now);
    if (!snapshot.id) return;
    liveIds.add(snapshot.id);
    const existing = historyById.get(snapshot.id);
    const next = existing ? { ...existing } : { id: snapshot.id, statusHistory: [] };
    next.repo = snapshot.repo || next.repo;
    next.issueId = snapshot.issueId ?? next.issueId;
    next.issueTitle = snapshot.issueTitle || next.issueTitle;
    next.status = snapshot.status || next.status;
    next.activity = snapshot.activity || next.activity;
    next.agentType = snapshot.agentType || next.agentType;
    next.prNumber = snapshot.prNumber ?? next.prNumber;
    if (!next.createdAt) {
      next.createdAt = snapshot.createdAt;
    } else if (snapshot.createdAt) {
      const existingCreated = coerceTimestamp(next.createdAt);
      const incomingCreated = coerceTimestamp(snapshot.createdAt);
      if (incomingCreated && existingCreated && incomingCreated > existingCreated) {
        next.createdAt = snapshot.createdAt;
      }
    }
    next.lastUpdatedAt = snapshot.lastUpdatedAt;

    const statusAt = pickSessionTimestamp(session, UPDATED_AT_KEYS) || now;
    const createdAtTs = coerceTimestamp(next.createdAt);
    const seedAt = next.statusHistory.length === 0 && createdAtTs ? createdAtTs : statusAt;
    recordStatusTransition(next, snapshot.status, snapshot.activity, seedAt);

    if (next.endedAt && !isCompletedStatus(snapshot.status, snapshot.activity)) {
      next.endedAt = null;
    }

    const completedAt = snapshot.endedAt ? coerceTimestamp(snapshot.endedAt) : null;
    if (completedAt && !next.endedAt) {
      next.endedAt = new Date(completedAt).toISOString();
    } else if (!next.endedAt && isCompletedStatus(snapshot.status, snapshot.activity)) {
      next.endedAt = toIsoString(statusAt) || new Date(now).toISOString();
    }

    historyById.set(snapshot.id, next);
  });

  for (const entry of historyById.values()) {
    if (!entry || !entry.id) continue;
    if (liveIds.has(entry.id)) continue;
    if (!entry.endedAt) {
      entry.endedAt = toIsoString(now) || new Date(now).toISOString();
    }
  }

  let entries = Array.from(historyById.values()).map(normalizeHistoryEntry);
  const active = entries.filter((entry) => !entry.endedAt);
  const completed = entries.filter((entry) => entry.endedAt);
  completed.sort((a, b) => (coerceTimestamp(b.endedAt) || 0) - (coerceTimestamp(a.endedAt) || 0));
  const trimmedCompleted = completed.slice(0, HISTORY_COMPLETED_MAX);
  entries = [...active, ...trimmedCompleted];
  entries.sort((a, b) => (coerceTimestamp(a.createdAt) || 0) - (coerceTimestamp(b.createdAt) || 0));
  if (entries.length > HISTORY_MAX_ENTRIES) {
    entries = entries.slice(entries.length - HISTORY_MAX_ENTRIES);
  }

  await writeHistoryFile(entries);
  return entries;
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
  const alive = pid ? isPidAlive(pid) : null;

  if (!pid) {
    return { ...session, lastSeenAlive };
  }

  if (alive) {
    return { ...session, lastSeenAlive: new Date(now).toISOString(), alive };
  }

  let status = session.status;
  let activity = session.activity;
  const statusLower = (status || '').toLowerCase();
  const activityLower = (activity || '').toLowerCase();
  const shouldArchiveForStale =
    statusLower.includes('working') ||
    statusLower.includes('cloning') ||
    activityLower.includes('working') ||
    activityLower.includes('cloning');
  if (statusLower.includes('working')) {
    status = 'exited';
    activity = 'exited';
  }

  if (shouldArchiveForStale && lastSeen && now - lastSeen > ONE_HOUR_MS) {
    status = 'archived';
    activity = 'archived';
  }

  return { ...session, status, activity, lastSeenAlive, alive: false };
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
      .then(async (data) => {
        try {
          await updateHistoryFromSessions(data.sessions || []);
        } catch (err) {
          // keep /api/agents responsive even if history write fails
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, sessions: [] }));
      });
    return;
  }

  if (req.url === '/api/history') {
    readHistoryFile()
      .then((history) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ history }));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, history: [] }));
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
