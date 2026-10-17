'use strict';

// The station's rules: what's playing, what plays next, and what counts as a valid pick.
// Kept free of HTTP and file I/O so it can be tested on its own.

const LIMITS = {
  maxDurationSec: 15 * 60,
  maxBlurb: 280,
  maxName: 40,
  maxTitle: 200,
  maxQueuedPerSubmitter: 3,
  historySize: 50,
  // If nothing was playing for longer than this (server was off), start fresh instead of
  // replaying everything that "would have" played in the meantime.
  maxGapMs: 60 * 60 * 1000,
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (VIDEO_ID.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([^/]+)/);
      if (m) id = m[2];
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Collapse whitespace and strip control characters.
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function publicTrack(t) {
  if (!t) return null;
  const { id, videoId, title, duration, name, blurb, addedAt } = t;
  return { id, videoId, title, duration, name, blurb, addedAt };
}

class Station {
  constructor(data = {}, { random = Math.random } = {}) {
    this.tracks = data.tracks || [];
    this.queue = data.queue || [];
    this.history = data.history || [];
    this.playing = data.playing || null;
    this.nextId = data.nextId || this.tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    this.random = random;
  }

  toJSON() {
    return {
      tracks: this.tracks,
      queue: this.queue,
      history: this.history,
      playing: this.playing,
      nextId: this.nextId,
    };
  }

  byId(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  validate(input) {
    const videoId = parseYouTubeId(input && (input.videoId || input.url));
    if (!videoId) return { error: "That doesn't look like a YouTube link." };
    const duration = Math.round(Number(input.duration));
    if (!Number.isFinite(duration) || duration < 1) {
      return { error: "Couldn't tell how long that video is. Try loading the preview again." };
    }
    if (duration > LIMITS.maxDurationSec) {
      return { error: `Songs can be up to ${LIMITS.maxDurationSec / 60} minutes long.` };
    }
    const blurb = cleanText(input.blurb, LIMITS.maxBlurb);
    if (!blurb) return { error: 'Tell people why they should hear it.' };
    const name = cleanText(input.name, LIMITS.maxName) || 'Anonymous';
    const title = cleanText(input.title, LIMITS.maxTitle) || 'Untitled';
    return { value: { videoId, duration, blurb, name, title } };
  }

  add(input, submitter, now = Date.now()) {
    const { error, value } = this.validate(input);
    if (error) return { error };
    if (this.queue.some((id) => this.byId(id).videoId === value.videoId)) {
      return { error: "That song is already in the queue." };
    }
    const pending = this.queue.filter((id) => this.byId(id).submitter === submitter).length;
    if (pending >= LIMITS.maxQueuedPerSubmitter) {
      return { error: `You already have ${pending} songs waiting. Let those play first.` };
    }
    const track = { id: this.nextId++, ...value, submitter, addedAt: now, plays: 0 };
    this.tracks.push(track);
    this.queue.push(track.id);
    this.tick(now);
    return { track };
  }

  // Advances the schedule to `now`. Returns true if anything changed.
  tick(now = Date.now()) {
    let changed = false;
    if (!this.playing) return this.startNext(now);
    while (this.playing) {
      const t = this.byId(this.playing.trackId);
      const end = this.playing.startedAt + (t ? t.duration * 1000 : 0);
      if (end > now) break;
      this.playing = null;
      changed = true;
      this.startNext(now - end > LIMITS.maxGapMs ? now : end);
    }
    return changed;
  }

  startNext(at) {
    const id = this.queue.length ? this.queue.shift() : this.pickRotation();
    if (id == null) return false;
    this.playing = { trackId: id, startedAt: at };
    this.history.push(id);
    if (this.history.length > LIMITS.historySize) this.history.shift();
    this.byId(id).plays++;
    return true;
  }

  // When nobody has queued anything, replay past picks, avoiding recent ones.
  pickRotation() {
    if (!this.tracks.length) return null;
    const queued = new Set(this.queue);
    const avoid = new Set(this.history.slice(-Math.min(10, this.tracks.length - 1)));
    let pool = this.tracks.filter((t) => !queued.has(t.id) && !avoid.has(t.id));
    if (!pool.length) pool = this.tracks.filter((t) => !queued.has(t.id));
    if (!pool.length) return null;
    return pool[Math.floor(this.random() * pool.length)].id;
  }

  state(now = Date.now()) {
    const current = this.playing && this.byId(this.playing.trackId);
    const recentIds = this.history.slice(0, current ? -1 : undefined).slice(-10).reverse();
    return {
      serverTime: now,
      nowPlaying: current
        ? { ...publicTrack(current), startedAt: this.playing.startedAt }
        : null,
      upNext: this.queue.slice(0, 20).map((id) => publicTrack(this.byId(id))),
      queueLength: this.queue.length,
      recent: recentIds.map((id) => publicTrack(this.byId(id))),
      librarySize: this.tracks.length,
    };
  }
}

module.exports = { Station, parseYouTubeId, LIMITS };
