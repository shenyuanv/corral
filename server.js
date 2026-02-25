#!/usr/bin/env node
// Corral server — serves index.html + /api/agents (live lasso status)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3377;
const SESSIONS_FILE = process.env.LASSO_SESSIONS || path.join(process.env.HOME, 'clawd/lasso/sessions.json');

function getLassoStatus(cb) {
  fs.readFile(SESSIONS_FILE, 'utf8', (err, raw) => {
    if (err) return cb(null, { sessions: [] });
    try {
      const data = JSON.parse(raw);
      // sessions.json has { sessions: { id: {...}, id: {...} } } — flatten to array
      const obj = data.sessions || {};
      const list = Object.entries(obj).map(([id, s]) => ({ id, ...s }));
      cb(null, { sessions: list });
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
