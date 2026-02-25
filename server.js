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
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_SCRIPT_TIMEOUT_MS = 15000;
const LASSO_CLEAN_TIMEOUT_MS = 15000;
const LASSO_BIN = process.env.LASSO_BIN || 'lasso';
const DEFAULT_CLAUDE_USAGE_SCRIPT = process.env.HOME
  ? path.join(process.env.HOME, 'clawd/scripts/claude-usage-report.sh')
  : null;
const CLAUDE_USAGE_SCRIPT = process.env.CLAUDE_USAGE_SCRIPT || DEFAULT_CLAUDE_USAGE_SCRIPT;
const HAS_CLAUDE_USAGE_ARGS = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_USAGE_SCRIPT_ARGS');
const CLAUDE_USAGE_SCRIPT_ARGS = HAS_CLAUDE_USAGE_ARGS
  ? (process.env.CLAUDE_USAGE_SCRIPT_ARGS || '').split(/\s+/).filter(Boolean)
  : ['--json'];
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
const usageCache = { ts: 0, data: null, pending: null };

function runLassoClean() {
  return new Promise((resolve, reject) => {
    execFile(LASSO_BIN, ['clean'], { timeout: LASSO_CLEAN_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr && stderr.trim() ? stderr.trim() : err.message;
        const error = new Error(message || 'lasso clean failed');
        error.code = err.code;
        return reject(error);
      }
      return resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

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
    s.includes('pr_closed') ||
    s.includes('merged') ||
    s.includes('dead') ||
    s.includes('exited') ||
    s.includes('archived') ||
    a.includes('pr_closed') ||
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
    const normalized = value.replace(/,/g, '').trim();
    const num = Number(normalized);
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

function resolveHomePath(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('~/')) {
    if (!process.env.HOME) return null;
    return path.join(process.env.HOME, value.slice(2));
  }
  return value;
}

function flattenUsageValues(obj, prefix, out) {
  if (!obj || typeof obj !== 'object') return;
  Object.entries(obj).forEach(([key, value]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    const num = coerceNumber(value);
    if (num !== null) {
      out.push({ key: nextKey.toLowerCase(), value: num });
    }
    if (value && typeof value === 'object') {
      flattenUsageValues(value, nextKey, out);
    }
  });
}

function findNumberByPatterns(entries, patterns) {
  for (const entry of entries) {
    if (patterns.every((pattern) => pattern.test(entry.key))) {
      return entry.value;
    }
  }
  return null;
}

function findValueByKey(obj, matcher) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [key, value] of Object.entries(obj)) {
    if (matcher.test(key)) return value;
    if (value && typeof value === 'object') {
      const nested = findValueByKey(value, matcher);
      if (nested !== null && nested !== undefined) return nested;
    }
  }
  return null;
}

function parseUsageJson(data) {
  const entries = [];
  flattenUsageValues(data, '', entries);

  let messagesUsed = findNumberByPatterns(entries, [/message/, /(used|usage|consumed|spent)/]);
  const messagesLimit = findNumberByPatterns(entries, [/message/, /(limit|max|cap|quota|allowed)/]);
  const messagesRemaining = findNumberByPatterns(entries, [/message/, /(remaining|left)/]);
  if (messagesUsed === null && messagesRemaining !== null && messagesLimit !== null) {
    messagesUsed = Math.max(0, messagesLimit - messagesRemaining);
  }

  let tokensUsed = findNumberByPatterns(entries, [/token/, /(used|usage|consumed|spent)/]);
  const tokensLimit = findNumberByPatterns(entries, [/token/, /(limit|max|cap|quota|allowed)/]);
  const tokensRemaining = findNumberByPatterns(entries, [/token/, /(remaining|left)/]);
  if (tokensUsed === null && tokensRemaining !== null && tokensLimit !== null) {
    tokensUsed = Math.max(0, tokensLimit - tokensRemaining);
  }

  const resetValue = findValueByKey(data, /reset|renew|refresh|rollover|window/i);
  const resetTs = coerceTimestamp(resetValue);
  const resetAt = resetTs ? new Date(resetTs).toISOString() : null;

  const metrics = [];
  if (messagesUsed !== null || messagesLimit !== null) {
    metrics.push({ id: 'messages', label: 'Messages', used: messagesUsed, limit: messagesLimit, unit: 'msgs' });
  }
  if (tokensUsed !== null || tokensLimit !== null) {
    metrics.push({ id: 'tokens', label: 'Tokens', used: tokensUsed, limit: tokensLimit, unit: 'tokens' });
  }

  return { metrics, resetAt };
}

function parseUsageText(raw) {
  const metrics = [];
  const clean = raw.replace(/,/g, '');

  const extractPair = (label) => {
    const pair = clean.match(new RegExp(`${label}[^\\d]*(\\d+)\\s*\\/\\s*(\\d+)`, 'i'));
    if (pair) {
      return { used: coerceNumber(pair[1]), limit: coerceNumber(pair[2]) };
    }
    const usedMatch = clean.match(new RegExp(`${label}[^\\d]*(?:used|usage|consumed|spent)[^\\d]*(\\d+)`, 'i'));
    const limitMatch = clean.match(new RegExp(`${label}[^\\d]*(?:limit|max|cap|quota|allowed)[^\\d]*(\\d+)`, 'i'));
    return {
      used: usedMatch ? coerceNumber(usedMatch[1]) : null,
      limit: limitMatch ? coerceNumber(limitMatch[1]) : null,
    };
  };

  const messagePair = extractPair('messages?');
  if (messagePair.used !== null || messagePair.limit !== null) {
    metrics.push({ id: 'messages', label: 'Messages', used: messagePair.used, limit: messagePair.limit, unit: 'msgs' });
  }

  const tokenPair = extractPair('tokens?');
  if (tokenPair.used !== null || tokenPair.limit !== null) {
    metrics.push({ id: 'tokens', label: 'Tokens', used: tokenPair.used, limit: tokenPair.limit, unit: 'tokens' });
  }

  const resetMatch = clean.match(/reset[^\\d]*(\\d{4}-\\d{2}-\\d{2}[^\\s]*)/i);
  const resetTs = resetMatch ? coerceTimestamp(resetMatch[1]) : null;
  const resetAt = resetTs ? new Date(resetTs).toISOString() : null;

  return { metrics, resetAt };
}

function parseClaudeUsageOutput(raw) {
  if (!raw || !raw.trim()) return { metrics: [], resetAt: null };
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parseUsageJson(parsed);
    } catch (err) {
      return parseUsageText(trimmed);
    }
  }
  return parseUsageText(trimmed);
}

async function getClaudeUsage() {
  const provider = {
    id: 'claude-max',
    name: 'Claude Max',
    status: 'unavailable',
    metrics: [],
    resetAt: null,
    source: 'script',
  };
  const scriptPath = resolveHomePath(CLAUDE_USAGE_SCRIPT);
  if (!scriptPath) {
    return { ...provider, error: 'Claude usage script not configured' };
  }
  try {
    await fs.promises.access(scriptPath, fs.constants.X_OK);
  } catch (err) {
    return { ...provider, error: 'Claude usage script not found or not executable' };
  }

  return new Promise((resolve) => {
    execFile(scriptPath, CLAUDE_USAGE_SCRIPT_ARGS, { timeout: USAGE_SCRIPT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ...provider, status: 'error', error: err.message });
        return;
      }
      const output = (stdout || '').trim() || (stderr || '').trim();
      // Try native Anthropic OAuth usage format first (five_hour/seven_day)
      try {
        const data = JSON.parse(output);
        if (data.five_hour || data.seven_day) {
          const metrics = [];
          if (data.five_hour) {
            metrics.push({
              id: 'five_hour',
              label: '5h window',
              utilization: Number(data.five_hour.utilization) || 0,
              resetAt: data.five_hour.resets_at || null,
            });
          }
          if (data.seven_day) {
            metrics.push({
              id: 'seven_day',
              label: '7d window',
              utilization: Number(data.seven_day.utilization) || 0,
              resetAt: data.seven_day.resets_at || null,
            });
          }
          const extraUsage = data.extra_usage || null;
          resolve({
            ...provider,
            status: 'ok',
            format: 'anthropic',
            metrics,
            extraUsage,
            resetAt: (data.five_hour && data.five_hour.resets_at) || null,
          });
          return;
        }
      } catch (e) {
        // fall through to generic parser
      }
      const parsed = parseClaudeUsageOutput(output);
      if (!parsed.metrics.length) {
        resolve({ ...provider, status: 'error', error: 'Unable to parse Claude usage output' });
        return;
      }
      resolve({
        ...provider,
        status: 'ok',
        metrics: parsed.metrics,
        resetAt: parsed.resetAt,
      });
    });
  });
}

async function getCodexUsageEstimate() {
  const provider = {
    id: 'codex',
    name: 'Codex',
    status: 'ok',
    metrics: [],
    resetAt: null,
    source: 'local',
    estimated: true,
  };
  let sessions = [];
  try {
    const status = await getLassoStatus();
    sessions = Array.isArray(status.sessions) ? status.sessions : [];
  } catch (err) {
    return { ...provider, status: 'error', error: err.message };
  }

  const totalTokens = sessions.reduce((sum, session) => {
    const tokens = coerceNumber(session.tokensUsed ?? session.tokens_used ?? session.tokenUsage ?? session.token_usage);
    return tokens === null ? sum : sum + tokens;
  }, 0);
  const hasTokens = sessions.some((session) => coerceNumber(session.tokensUsed ?? session.tokens_used ?? session.tokenUsage ?? session.token_usage) !== null);
  const limitTokens = coerceNumber(process.env.CODEX_USAGE_LIMIT_TOKENS || process.env.CODEX_USAGE_LIMIT);
  const resetTs = coerceTimestamp(process.env.CODEX_USAGE_RESET_AT || process.env.CODEX_USAGE_RESET);
  const resetAt = resetTs ? new Date(resetTs).toISOString() : null;

  provider.metrics = [
    {
      id: 'tokens',
      label: 'Tokens',
      used: hasTokens ? totalTokens : null,
      limit: limitTokens,
      unit: 'tokens',
      estimated: true,
    },
  ];
  provider.resetAt = resetAt;
  provider.note = hasTokens ? 'Estimated from active agent logs' : 'No token logs found yet';
  return provider;
}

async function buildUsageData() {
  const [claude, codex] = await Promise.all([getClaudeUsage(), getCodexUsageEstimate()]);
  return {
    fetchedAt: new Date().toISOString(),
    providers: [claude, codex].filter(Boolean),
  };
}

async function getUsageData() {
  const now = Date.now();
  if (usageCache.data && now - usageCache.ts < USAGE_CACHE_TTL_MS) {
    return usageCache.data;
  }
  if (usageCache.pending) return usageCache.pending;
  usageCache.pending = buildUsageData()
    .then((data) => {
      usageCache.data = data;
      usageCache.ts = Date.now();
      return data;
    })
    .catch((err) => {
      const fallback = { fetchedAt: new Date().toISOString(), providers: [], error: err.message };
      usageCache.data = fallback;
      usageCache.ts = Date.now();
      return fallback;
    })
    .finally(() => {
      usageCache.pending = null;
    });
  return usageCache.pending;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

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

  if (req.url === '/api/usage') {
    getUsageData()
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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

  if (req.url === '/api/clean') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    runLassoClean()
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message || 'lasso clean failed' }));
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
