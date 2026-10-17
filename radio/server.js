'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Station } = require('./station');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'station.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SUBMIT_COOLDOWN_MS = 30 * 1000;

function load() {
  try {
    return new Station(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${DATA_FILE}:`, err.message);
    return new Station();
  }
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(station));
  fs.renameSync(tmp, DATA_FILE);
}

const station = load();
if (station.tick()) save();
setInterval(() => {
  if (station.tick()) save();
}, 1000);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const lastSubmit = new Map();

function submitterKey(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/api/state') {
    station.tick();
    return sendJson(res, 200, station.state());
  }

  if (req.method === 'POST' && pathname === '/api/tracks') {
    const key = submitterKey(req);
    const wait = (lastSubmit.get(key) || 0) + SUBMIT_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      return sendJson(res, 429, { error: `Slow down a little. Try again in ${Math.ceil(wait / 1000)}s.` });
    }
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Bad request.' });
    }
    const { error, track } = station.add(input, key);
    if (error) return sendJson(res, 400, { error });
    lastSubmit.set(key, Date.now());
    save();
    return sendJson(res, 201, { id: track.id, position: station.queue.indexOf(track.id) + 1 });
  }

  const file = req.method === 'GET' && STATIC[pathname];
  if (file) {
    res.writeHead(200, { 'Content-Type': file[1] });
    return fs.createReadStream(path.join(__dirname, 'public', file[0])).pipe(res);
  }

  sendJson(res, 404, { error: 'Not found.' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
    });
  })
  .listen(PORT, () => console.log(`Community radio on http://localhost:${PORT}`));
