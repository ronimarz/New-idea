'use strict';

// The ways listeners connect: live chat, private thank-you notes, and who's tuned in.
// Like station.js, this has no web or file code. `key` is always a hashed visitor id
// and is never sent to other listeners.

const { cleanText } = require('./station');

const LIMITS = {
  maxChat: 300,
  chatKept: 500,
  chatPage: 100,
  chatCooldownMs: 2000,
  maxNote: 300,
  notesPerPerson: 100,
  noteCooldownMs: 10 * 1000,
  maxName: 40,
  maxLocation: 60,
  listeningWindowMs: 20 * 1000,
  placesShown: 6,
};

function who(input) {
  return {
    name: cleanText(input && input.name, LIMITS.maxName) || 'Anonymous',
    location: cleanText(input && input.location, LIMITS.maxLocation),
  };
}

class Chat {
  constructor(data = {}) {
    this.messages = data.messages || [];
    this.nextId = data.nextId || this.messages.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    this.lastPost = new Map();
  }

  toJSON() {
    return { messages: this.messages, nextId: this.nextId };
  }

  // `track` is the song on air, so the chat can show which song people were talking about.
  post(input, key, track, now = Date.now()) {
    const text = cleanText(input && input.text, LIMITS.maxChat);
    if (!text) return { error: 'Write something first.' };
    if (this.lastPost.has(key) && now - this.lastPost.get(key) < LIMITS.chatCooldownMs) {
      return { error: 'One moment, you just sent a message.' };
    }
    this.lastPost.set(key, now);
    const message = {
      id: this.nextId++,
      at: now,
      ...who(input),
      text,
      trackId: track ? track.id : null,
      trackTitle: track ? track.title : '',
      key,
    };
    this.messages.push(message);
    if (this.messages.length > LIMITS.chatKept) this.messages.shift();
    return { message };
  }

  since(afterId, viewer) {
    return this.messages
      .filter((m) => m.id > afterId)
      .slice(-LIMITS.chatPage)
      .map(({ id, at, name, location, text, trackId, trackTitle, key }) => ({
        id,
        at,
        name,
        location,
        text,
        trackId,
        trackTitle,
        mine: viewer != null && key === viewer,
      }));
  }

  remove(id) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.id !== id);
    return this.messages.length < before;
  }

  removeByKey(key) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.key !== key);
    return before - this.messages.length;
  }
}

// Private notes to the person who picked a song. Only the recipient ever sees them.
class Notes {
  constructor(data = {}) {
    this.notes = data.notes || [];
    this.nextId = data.nextId || this.notes.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    this.lastSent = new Map();
  }

  toJSON() {
    return { notes: this.notes, nextId: this.nextId };
  }

  send(track, input, from, now = Date.now()) {
    if (!track) return { error: 'That song is no longer on the station.' };
    if (track.submitter === from) return { error: "That's your own pick." };
    const text = cleanText(input && input.text, LIMITS.maxNote);
    if (!text) return { error: 'Write a few words first.' };
    if (this.notes.some((n) => n.trackId === track.id && n.from === from)) {
      return { error: 'You already sent a note for this pick.' };
    }
    if (this.lastSent.has(from) && now - this.lastSent.get(from) < LIMITS.noteCooldownMs) {
      return { error: 'One moment, you just sent a note.' };
    }
    this.lastSent.set(from, now);
    const note = {
      id: this.nextId++,
      at: now,
      to: track.submitter,
      from,
      ...who(input),
      text,
      trackId: track.id,
      trackTitle: track.title,
      read: false,
    };
    this.notes.push(note);
    const mine = this.notes.filter((n) => n.to === note.to);
    if (mine.length > LIMITS.notesPerPerson) this.notes.splice(this.notes.indexOf(mine[0]), 1);
    return { note };
  }

  inbox(viewer) {
    const mine = this.notes.filter((n) => n.to === viewer);
    return {
      unread: mine.filter((n) => !n.read).length,
      notes: mine
        .slice()
        .reverse()
        .map(({ id, at, name, location, text, trackTitle, read }) => ({
          id,
          at,
          name,
          location,
          text,
          trackTitle,
          read,
        })),
    };
  }

  // Ids of the songs this viewer has already thanked, so the button can say "Sent".
  sentFor(viewer) {
    return this.notes.filter((n) => n.from === viewer).map((n) => n.trackId);
  }

  markRead(viewer) {
    for (const n of this.notes) if (n.to === viewer) n.read = true;
  }

  // The recipient can clear a note away. Nobody else can see or touch it.
  hide(id, viewer) {
    const i = this.notes.findIndex((n) => n.id === id && n.to === viewer);
    if (i === -1) return false;
    this.notes.splice(i, 1);
    return true;
  }

  removeByKey(key) {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.from !== key);
    return before - this.notes.length;
  }
}

// Who's listening right now. Kept in memory only; it's live by nature.
class Presence {
  constructor() {
    this.seen = new Map();
  }

  ping(key, location, now = Date.now()) {
    this.seen.set(key, { at: now, location: cleanText(location, LIMITS.maxLocation) });
  }

  summary(now = Date.now()) {
    const counts = new Map();
    let count = 0;
    for (const [key, v] of this.seen) {
      if (now - v.at > LIMITS.listeningWindowMs) {
        this.seen.delete(key);
        continue;
      }
      count++;
      if (v.location) {
        // Group "austin, texas" and "Austin, Texas" together, keeping the first spelling.
        const k = v.location.toLowerCase();
        const c = counts.get(k) || { name: v.location, n: 0 };
        c.n++;
        counts.set(k, c);
      }
    }
    const places = [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.name);
    return {
      count,
      places: places.slice(0, LIMITS.placesShown),
      morePlaces: Math.max(0, places.length - LIMITS.placesShown),
    };
  }
}

module.exports = { Chat, Notes, Presence, LIMITS };
