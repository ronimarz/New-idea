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

// A song holds every pick of it: who chose it, from where, and their answers.
// Newest first, since the newest pick is usually why it's playing now.
function picksOf(t) {
  return [...t.picks].sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
}

function pickedByViewer(t, viewer) {
  return viewer != null && t.picks.some((p) => p.submitter === viewer);
}

// What listeners may see. `viewer` is the hashed visitor key, used only to say whether
// a pick is their own and whether they've hearted the song. It is never sent out itself.
function publicTrack(t, viewer) {
  if (!t) return null;
  const { id, videoId, title, duration, addedAt, language } = t;
  const hearts = t.hearts || [];
  return {
    id,
    videoId,
    title,
    duration,
    addedAt,
    language: language || 'english',
    picks: picksOf(t).map((p) => ({
      id: p.id,
      name: p.name,
      location: p.location || '',
      answers: p.answers,
      addedAt: p.addedAt,
      mine: viewer != null && p.submitter === viewer,
    })),
    hearts: hearts.length,
    hearted: viewer != null && hearts.includes(viewer),
    mine: pickedByViewer(t, viewer),
  };
}

// Songs used to hold a single person's pick, and the same song could be on the station
// more than once. Turn those into one song per video, holding all its picks.
function migrate(data) {
  let nextPickId =
    data.nextPickId ||
    (data.tracks || []).reduce((m, t) => Math.max(m, ...(t.picks || []).map((p) => p.id)), 0) + 1;
  const tracks = [];
  const remap = new Map();
  for (const t of data.tracks || []) {
    const song = t.picks
      ? t
      : {
          id: t.id,
          videoId: t.videoId,
          title: t.title,
          duration: t.duration,
          language: t.language || 'english',
          ...(t.flag ? { flag: t.flag } : {}),
          addedAt: t.addedAt,
          plays: t.plays || 0,
          hearts: t.hearts || [],
          picks: [
            {
              id: nextPickId++,
              submitter: t.submitter,
              name: t.name || 'Anonymous',
              location: t.location || '',
              answers: answersOf(t),
              addedAt: t.addedAt,
            },
          ],
        };
    const same = tracks.find((x) => x.videoId === song.videoId);
    if (!same) {
      tracks.push(song);
      continue;
    }
    same.picks.push(...song.picks);
    same.hearts = [...new Set([...same.hearts, ...song.hearts])];
    same.plays += song.plays;
    remap.set(song.id, same.id);
  }
  const to = (id) => (remap.has(id) ? remap.get(id) : id);
  return {
    tracks,
    nextPickId,
    queue: [...new Set((data.queue || []).map(to))],
    history: (data.history || []).map(to),
    playing: data.playing ? { ...data.playing, trackId: to(data.playing.trackId) } : null,
    nextPick: data.nextPick != null ? to(data.nextPick) : null,
  };
}

class Station {
  constructor(data = {}, { random = Math.random, languages = DEFAULT_LANGUAGES } = {}) {
    const m = migrate(data);
    this.tracks = m.tracks;
    this.queue = m.queue;
    this.history = m.history;
    this.playing = m.playing;
    this.nextId = data.nextId || this.tracks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    this.nextPickId = m.nextPickId;
    // A past pick chosen ahead of time, so listeners know what follows the current song.
    this.nextPick = m.nextPick;
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
      nextPickId: this.nextPickId,
      nextPick: this.nextPick,
    };
  }

  byId(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  byVideo(videoId) {
    return this.tracks.find((t) => t.videoId === videoId) || null;
  }

  // Whether a song is already on the station, so people know before they fill in the form.
  lookup(videoId) {
    const t = this.byVideo(videoId);
    if (!t) return { exists: false };
    const onAir = !!this.playing && this.playing.trackId === t.id;
    const position = this.queue.indexOf(t.id) + 1;
    return { exists: true, title: t.title, picks: t.picks.length, onAir, position };
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

  // Adds someone's pick. If the song is already on the station, their answers are added
  // to it; it is never queued a second time. Returns { track, pick, joined }.
  add(input, submitter, now = Date.now(), questions = DEFAULT_QUESTIONS) {
    const { error, value } = this.validate(input, questions);
    if (error) return { error };
    const { videoId, duration, title, language, flag, ...rest } = value;
    const pick = { id: this.nextPickId++, submitter, ...rest, addedAt: now };
    let track = this.byVideo(videoId);
    if (track && track.picks.some((p) => p.submitter === submitter)) {
      return { error: "You've already picked this song." };
    }
    if (!track) {
      const pending = this.queue.filter((id) => pickedByViewer(this.byId(id), submitter)).length;
      if (pending >= LIMITS.maxQueuedPerSubmitter) {
        return { error: `You already have ${pending} songs waiting. Let those play first.` };
      }
    }
    if (track) {
      track.picks.push(pick);
    } else {
      track = { id: this.nextId++, videoId, duration, title, language, ...(flag ? { flag } : {}),
        addedAt: now, plays: 0, hearts: [], picks: [pick] };
      this.tracks.push(track);
      this.queue.push(track.id);
    }
    this.tick(now);
    return { track, pick, joined: track.picks.length > 1 };
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

  // Admin: remove one person's pick. A song with no picks left is removed too.
  removePick(trackId, pickId, now = Date.now()) {
    const t = this.byId(trackId);
    if (!t || !t.picks.some((p) => p.id === pickId)) return false;
    t.picks = t.picks.filter((p) => p.id !== pickId);
    if (!t.picks.length) this.remove(trackId, now);
    return true;
  }

  // Admin (ban): remove every pick by one person. Returns how many picks went.
  removeBySubmitter(submitter, now = Date.now()) {
    let count = 0;
    for (const t of [...this.tracks]) {
      for (const p of t.picks.filter((x) => x.submitter === submitter)) {
        this.removePick(t.id, p.id, now);
        count++;
      }
    }
    return count;
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
    if (pickedByViewer(t, viewer)) return { error: "That's your pick." };
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
  picksOf,
  parseYouTubeId,
  cleanText,
  looksNonEnglish,
  languageRule,
  LIMITS,
  LANGUAGES,
};
