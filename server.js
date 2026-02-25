#!/usr/bin/env node
// Corral server — serves index.html + /api/agents (live lasso status)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3377;
const LASSO = process.env.LASSO_BIN || 'lasso';

function getLassoStatus(cb) {
  execFile(LASSO, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
    if (err) return cb(err, null);
    try {
      cb(null, JSON.parse(stdout));
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
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🤠 Corral running at http://localhost:${PORT}`);
});
