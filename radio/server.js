'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Station, LANGUAGES, languageRule, picksOf } = require('./station');
const { Chat, Notes, Presence } = require('./community');
const { Questions } = require('./questions');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'station.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SUBMIT_COOLDOWN_MS = 30 * 1000;
const QUESTION_ROTATION = process.env.QUESTION_ROTATION === 'month' ? 'month' : 'week';
const STATION_LANGUAGES = (process.env.STATION_LANGUAGES || 'english,instrumental')
  .split(',')
  .map((l) => l.trim())
  .filter((l) => LANGUAGES[l]);

// Without ADMIN_TOKEN set, a fresh one is made at each start and printed below.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('base64url');

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${DATA_FILE}:`, err.message);
  }
  // Files from before chat existed held only the station.
  if (data.tracks) data = { station: data };
  return {
    station: new Station(data.station, { languages: STATION_LANGUAGES }),
    chat: new Chat(data.chat),
    notes: new Notes(data.notes),
    questions: new Questions(data.questions, { rotation: QUESTION_ROTATION }),
    banned: new Set(data.banned || []),
  };
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ station, chat, notes, questions, banned: [...banned] }));
  fs.renameSync(tmp, DATA_FILE);
}

const { station, chat, notes, questions, banned } = load();
const presence = new Presence();
if (station.tick()) save();
setInterval(() => {
  if (station.tick()) save();
}, 1000);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};

const lastSubmit = new Map();

function submitterKey(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

function isAdmin(req) {
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return given.length > 0 && crypto.timingSafeEqual(a, b);
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

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
}

const BANNED = { error: "Sorry, you can't post here anymore." };

async function handleAdmin(req, res, pathname) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Wrong admin password.' });
  const now = Date.now();
  let m;

  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    station.tick(now);
    const status = (t) =>
      station.playing && station.playing.trackId === t.id
        ? 'on air'
        : station.queue.includes(t.id)
          ? `queued #${station.queue.indexOf(t.id) + 1}`
          : 'played';
    return sendJson(res, 200, {
      tracks: station.tracks
        .slice()
        .reverse()
        .map((t) => ({
          id: t.id,
          videoId: t.videoId,
          title: t.title,
          picks: picksOf(t).map((p) => ({
            id: p.id,
            name: p.name,
            location: p.location || '',
            answers: p.answers,
            addedAt: p.addedAt,
            author: p.submitter,
          })),
          language: t.language || 'english',
          flag: t.flag || '',
          addedAt: t.addedAt,
          plays: t.plays,
          hearts: (t.hearts || []).length,
          status: status(t),
        })),
      chat: chat.messages
        .slice(-200)
        .reverse()
        .map(({ id, at, name, location, text, key }) => ({ id, at, name, location, text, author: key })),
      banned: [...banned],
      questions: { ...questions.current(now), list: questions.sets },
      listeners: presence.summary(now).count,
    });
  }
  // Question sets: add, edit, delete, reorder, use now, and pause the rotation.
  if (pathname.startsWith('/api/admin/question-sets') || pathname === '/api/admin/rotation') {
    const body = req.method === 'DELETE' ? {} : await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request.' });
    const id = Number((pathname.match(/^\/api\/admin\/question-sets\/(\d+)/) || [])[1]);
    const route = `${req.method} ${pathname.replace(/\/\d+/, '/:id')}`;
    let result;
    if (route === 'POST /api/admin/question-sets') result = questions.add(body.questions);
    else if (route === 'PUT /api/admin/question-sets/:id') result = questions.edit(id, body.questions);
    else if (route === 'DELETE /api/admin/question-sets/:id') result = questions.remove(id, now);
    else if (route === 'POST /api/admin/question-sets/:id/move') result = questions.move(id, body.by);
    else if (route === 'POST /api/admin/question-sets/:id/use') result = questions.use(id, now);
    else if (route === 'PUT /api/admin/rotation') result = questions.setPaused(body.paused, now);
    else return sendJson(res, 404, { error: 'Not found.' });
    if (result.error) return sendJson(res, 400, result);
    save();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/admin/skip') {
    station.skip(now);
    save();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/tracks\/(\d+)$/))) {
    station.remove(Number(m[1]), now);
    save();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/tracks\/(\d+)\/picks\/(\d+)$/))) {
    station.removePick(Number(m[1]), Number(m[2]), now);
    save();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/chat\/(\d+)$/))) {
    chat.remove(Number(m[1]));
    save();
    return sendJson(res, 200, { ok: true });
  }
  // Ban someone and clear away everything they posted: songs, chat and notes.
  if (req.method === 'POST' && pathname === '/api/admin/ban') {
    const body = await readJson(req);
    const key = body && typeof body.author === 'string' && body.author;
    if (!key) return sendJson(res, 400, { error: 'Who should be banned?' });
    banned.add(key);
    const removed = {
      songs: station.removeBySubmitter(key, now),
      messages: chat.removeByKey(key),
      notes: notes.removeByKey(key),
    };
    save();
    return sendJson(res, 200, { removed });
  }
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/ban\/([0-9a-f]+)$/))) {
    banned.delete(m[1]);
    save();
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const key = submitterKey(req);
  const now = Date.now();
  let m;

  if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, pathname);

  if (req.method === 'GET' && pathname === '/api/state') {
    station.tick(now);
    presence.ping(key, url.searchParams.get('from'), now);
    return sendJson(res, 200, {
      ...station.state(now, key),
      languages: STATION_LANGUAGES.map((id) => ({ id, label: LANGUAGES[id] })),
      languageRule: languageRule(STATION_LANGUAGES),
      questions: questions.current(now),
      listeners: presence.summary(now),
      inbox: notes.inbox(key),
      thanked: notes.sentFor(key),
    });
  }

  if (req.method === 'POST' && pathname === '/api/tracks') {
    if (banned.has(key)) return sendJson(res, 403, BANNED);
    const wait = (lastSubmit.get(key) || 0) + SUBMIT_COOLDOWN_MS - now;
    if (wait > 0) {
      return sendJson(res, 429, { error: `Slow down a little. Try again in ${Math.ceil(wait / 1000)}s.` });
    }
    const input = await readJson(req);
    if (!input) return sendJson(res, 400, { error: 'Bad request.' });
    // The questions can change while someone is filling in the form.
    if (!questions.matches(input.questions, now)) {
      return sendJson(res, 409, {
        error: 'The questions just changed. Your answers are still there; check they fit the new questions.',
        questions: questions.current(now),
      });
    }
    const { error, track, joined } = station.add(input, key, now, questions.current(now).questions);
    if (error) return sendJson(res, 400, { error });
    lastSubmit.set(key, now);
    save();
    return sendJson(res, 201, { id: track.id, joined, position: station.queue.indexOf(track.id) + 1 });
  }

  m = pathname.match(/^\/api\/tracks\/(\d+)\/heart$/);
  if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
    const result = station.heart(Number(m[1]), key, req.method === 'PUT');
    if (result.error) return sendJson(res, 400, result);
    save();
    return sendJson(res, 200, result);
  }

  m = pathname.match(/^\/api\/tracks\/(\d+)\/notes$/);
  if (m && req.method === 'POST') {
    if (banned.has(key)) return sendJson(res, 403, BANNED);
    const input = await readJson(req);
    if (!input) return sendJson(res, 400, { error: 'Bad request.' });
    const track = station.byId(Number(m[1]));
    const pick = track && track.picks.find((p) => p.id === Number(input.pick));
    const { error } = notes.send(track, pick, input, key, now);
    if (error) return sendJson(res, 400, { error });
    save();
    return sendJson(res, 201, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/notes/read') {
    notes.markRead(key);
    save();
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/notes\/(\d+)$/);
  if (m && req.method === 'DELETE') {
    if (notes.hide(Number(m[1]), key)) save();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/chat') {
    const after = Number(url.searchParams.get('after')) || 0;
    return sendJson(res, 200, { messages: chat.since(after, key) });
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    if (banned.has(key)) return sendJson(res, 403, BANNED);
    const input = await readJson(req);
    if (!input) return sendJson(res, 400, { error: 'Bad request.' });
    station.tick(now);
    const onAir = station.playing && station.byId(station.playing.trackId);
    const { error } = chat.post(input, key, onAir, now);
    if (error) return sendJson(res, 400, { error });
    save();
    return sendJson(res, 201, { ok: true });
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
  .listen(PORT, () => {
    console.log(`Community radio on http://localhost:${PORT}`);
    console.log(`Admin page:  http://localhost:${PORT}/admin`);
    if (!process.env.ADMIN_TOKEN) {
      console.log(`Admin password (changes every restart; set ADMIN_TOKEN to keep one): ${ADMIN_TOKEN}`);
    }
  });
