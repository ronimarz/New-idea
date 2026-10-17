'use strict';

// The station's rules: what's playing, what plays next, and what counts as a valid pick.
// Kept free of HTTP and file I/O so it can be tested on its own.

const LIMITS = {
  maxDurationSec: 15 * 60,
  minAnswer: 40,
  maxAnswer: 240,
  maxName: 40,
  maxLocation: 60,
  maxTitle: 200,
  maxQueuedPerSubmitter: 3,
  historySize: 50,
  // If nothing was playing for longer than this (server was off), start fresh instead of
  // replaying everything that "would have" played in the meantime.
  maxGapMs: 60 * 60 * 1000,
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// The first set of questions people answer when adding a song. More sets rotate in
// from questions.js.
const DEFAULT_QUESTIONS = [
  'Why this song?',
  'What does it mean to you?',
  'When did you first hear it?',
];

// What a song's lyrics can be. The station accepts only the ones it's configured for.
const LANGUAGES = {
  english: 'English',
  instrumental: 'Instrumental (no lyrics)',
};
const DEFAULT_LANGUAGES = ['english', 'instrumental'];
const RULE_WORDS = { english: 'in English', instrumental: 'instrumental' };

function languageRule(languages) {
  return `For now, the station only plays songs that are ${languages.map((l) => RULE_WORDS[l]).join(' or ')}.`;
}

// A title written mostly in a non-Latin script (Korean, Cyrillic, Arabic…) suggests the
// song may not be in English. This only flags it for the admin to check; it never blocks.
function looksNonEnglish(title) {
  const letters = title.match(/\p{L}/gu) || [];
  if (letters.length < 3) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.5;
}

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

// Picks from before the three questions had a single "why" blurb.
function answersOf(t) {
  if (t.answers) return t.answers;
  return t.blurb ? [{ question: 'Why should people hear this?', answer: t.blurb }] : [];
}

// What listeners may see. `viewer` is the hashed visitor key, used only to say whether
// this is their own pick and whether they've hearted it. It is never sent out itself.
function publicTrack(t, viewer) {
  if (!t) return null;
  const { id, videoId, title, duration, name, location, addedAt, language } = t;
  const hearts = t.hearts || [];
  return {
    id,
    videoId,
    title,
    duration,
    name,
    location: location || '',
    answers: answersOf(t),
    addedAt,
    language: language || 'english',
    hearts: hearts.length,
    hearted: viewer != null && hearts.includes(viewer),
    mine: viewer != null && t.submitter === viewer,
  };
}

class Station {
  constructor(data = {}, { random = Math.random, languages = DEFAULT_LANGUAGES } = {}) {
    this.tracks = data.tracks || [];
    this.queue = data.queue || [];
    this.history = data.history || [];
    this.playing = data.playing || null;
    this.nextId = data.nextId || this.tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    // A past pick chosen ahead of time, so listeners know what follows the current song.
    this.nextPick = data.nextPick || null;
    this.random = random;
    this.languages = languages;
  }

  toJSON() {
    return {
      tracks: this.tracks,
      queue: this.queue,
      history: this.history,
      playing: this.playing,
      nextId: this.nextId,
      nextPick: this.nextPick,
    };
  }

  byId(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  validate(input, questions = DEFAULT_QUESTIONS) {
    const videoId = parseYouTubeId(input && (input.videoId || input.url));
    if (!videoId) return { error: "That doesn't look like a YouTube link." };
    const duration = Math.round(Number(input.duration));
    if (!Number.isFinite(duration) || duration < 1) {
      return { error: "Couldn't tell how long that video is. Try loading the preview again." };
    }
    if (duration > LIMITS.maxDurationSec) {
      return { error: `Songs can be up to ${LIMITS.maxDurationSec / 60} minutes long.` };
    }
    const given = Array.isArray(input.answers) ? input.answers : [];
    const answers = [];
    for (const [i, question] of questions.entries()) {
      const answer = cleanText(given[i], LIMITS.maxAnswer);
      if (!answer) return { error: `Answer “${question}”` };
      if (answer.length < LIMITS.minAnswer) {
        return { error: `Say a little more for “${question}” (at least ${LIMITS.minAnswer} characters).` };
      }
      answers.push({ question, answer });
    }
    const location = cleanText(input.location, LIMITS.maxLocation);
    if (!location) return { error: "Tell people where you're listening from." };
    const language = input.language;
    if (!this.languages.includes(language)) return { error: languageRule(this.languages) };
    const name = cleanText(input.name, LIMITS.maxName) || 'Anonymous';
    const title = cleanText(input.title, LIMITS.maxTitle) || 'Untitled';
    const value = { videoId, duration, answers, name, location, title, language };
    if (language === 'english' && looksNonEnglish(title)) value.flag = 'Title may not be in English';
    return { value };
  }

  add(input, submitter, now = Date.now(), questions = DEFAULT_QUESTIONS) {
    const { error, value } = this.validate(input, questions);
    if (error) return { error };
    if (this.queue.some((id) => this.byId(id).videoId === value.videoId)) {
      return { error: "That song is already in the queue." };
    }
    const pending = this.queue.filter((id) => this.byId(id).submitter === submitter).length;
    if (pending >= LIMITS.maxQueuedPerSubmitter) {
      return { error: `You already have ${pending} songs waiting. Let those play first.` };
    }
    const track = { id: this.nextId++, ...value, submitter, addedAt: now, plays: 0, hearts: [] };
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
    let id = this.queue.length ? this.queue.shift() : this.validNextPick();
    if (id == null) id = this.pickRotation();
    this.nextPick = null;
    if (id == null) return false;
    this.playing = { trackId: id, startedAt: at };
    this.history.push(id);
    if (this.history.length > LIMITS.historySize) this.history.shift();
    this.byId(id).plays++;
    return true;
  }

  validNextPick() {
    const t = this.nextPick != null && this.byId(this.nextPick);
    return t && !(this.playing && this.playing.trackId === t.id) ? t.id : null;
  }

  // What plays after the current song: the oldest new submission, or else a past pick.
  upcoming() {
    if (this.queue.length) return this.byId(this.queue[0]);
    if (this.validNextPick() == null) this.nextPick = this.pickRotation();
    return this.byId(this.nextPick);
  }

  // Admin: take a song off the station entirely. If it's on air, the next one starts now.
  remove(trackId, now = Date.now()) {
    if (!this.byId(trackId)) return false;
    this.tracks = this.tracks.filter((t) => t.id !== trackId);
    this.queue = this.queue.filter((id) => id !== trackId);
    this.history = this.history.filter((id) => id !== trackId);
    if (this.playing && this.playing.trackId === trackId) {
      this.playing = null;
      this.startNext(now);
    }
    return true;
  }

  removeBySubmitter(submitter, now = Date.now()) {
    const ids = this.tracks.filter((t) => t.submitter === submitter).map((t) => t.id);
    for (const id of ids) this.remove(id, now);
    return ids.length;
  }

  // Admin: end the current song early.
  skip(now = Date.now()) {
    if (!this.playing) return false;
    this.playing = null;
    this.startNext(now);
    return true;
  }

  // Hearts only ever add: there's no way to count against a song.
  heart(trackId, viewer, on = true) {
    const t = this.byId(trackId);
    if (!t) return { error: 'That song is no longer on the station.' };
    if (t.submitter === viewer) return { error: "That's your pick." };
    t.hearts = t.hearts || [];
    const has = t.hearts.includes(viewer);
    if (on && !has) t.hearts.push(viewer);
    if (!on && has) t.hearts.splice(t.hearts.indexOf(viewer), 1);
    return { hearts: t.hearts.length, hearted: on };
  }

  // When nobody has queued anything, replay past picks, avoiding recent ones.
  // Songs people hearted come back a little more often (up to 3x).

  pickRotation() {
    if (!this.tracks.length) return null;
    const queued = new Set(this.queue);
    const avoid = new Set(this.history.slice(-Math.min(10, this.tracks.length - 1)));
    let pool = this.tracks.filter((t) => !queued.has(t.id) && !avoid.has(t.id));
    if (!pool.length) pool = this.tracks.filter((t) => !queued.has(t.id));
    if (!pool.length) return null;
    const weight = (t) => 1 + Math.min((t.hearts || []).length, 10) / 5;
    let r = this.random() * pool.reduce((sum, t) => sum + weight(t), 0);
    for (const t of pool) {
      r -= weight(t);
      if (r < 0) return t.id;
    }
    return pool[pool.length - 1].id;
  }

  state(now = Date.now(), viewer = null) {
    const current = this.playing && this.byId(this.playing.trackId);
    const recentIds = this.history.slice(0, current ? -1 : undefined).slice(-10).reverse();
    const next = current && this.upcoming();
    return {
      serverTime: now,
      nowPlaying: current
        ? { ...publicTrack(current, viewer), startedAt: this.playing.startedAt }
        : null,
      // Lets players start the next song the moment this one ends, even in a background tab.
      next: next
        ? {
            ...publicTrack(next, viewer),
            startsAt: this.playing.startedAt + current.duration * 1000,
            replay: !this.queue.length,
          }
        : null,
      upNext: this.queue.slice(0, 20).map((id) => publicTrack(this.byId(id), viewer)),
      queueLength: this.queue.length,
      recent: recentIds.map((id) => publicTrack(this.byId(id), viewer)),
      librarySize: this.tracks.length,
    };
  }
}

module.exports = {
  Station,
  DEFAULT_QUESTIONS,
  answersOf,
  parseYouTubeId,
  cleanText,
  looksNonEnglish,
  languageRule,
  LIMITS,
  LANGUAGES,
};
