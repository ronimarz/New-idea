'use strict';

// The three questions people answer when they add a song. The admin manages a list of
// question sets; the station moves to the next set every week or month, or stays on one
// while the rotation is paused.

const { cleanText, DEFAULT_QUESTIONS } = require('./station');

// The sets a new station starts with. After that, the list lives in the saved data.
const STARTER_SETS = [
  DEFAULT_QUESTIONS,
  [
    'Where were you the first time you really listened to this?',
    'What do you hear in it that someone else might miss?',
    'Who would you play this for, and why?',
  ],
  [
    'What were you going through when this song found you?',
    'Which line or moment stays with you?',
    'How do you feel when it ends?',
  ],
  [
    'Who introduced you to this song, or how did you find it?',
    'What memory comes back when you hear it?',
    'Why does it belong on the radio this week?',
  ],
  [
    'What does this song sound like to you, in your own words?',
    'When do you reach for it?',
    'What has it taught you, if anything?',
  ],
  [
    'Where would you want to be listening to this right now?',
    'What does it remind you of from home?',
    'Who do you think about when it plays?',
  ],
  [
    'How has this song changed for you over the years?',
    'What part do you always wait for?',
    'What would you tell someone hearing it for the first time?',
  ],
  [
    'What were you doing the last time this song stopped you in your tracks?',
    'What feeling does it give words to?',
    'Why this song, out of all the songs you love?',
  ],
];

const LIMITS = { maxQuestion: 140, maxSets: 100 };
const DAY = 24 * 3600 * 1000;
const FIRST_MONDAY = 4 * DAY; // 1970-01-05, so weeks turn over at Monday 00:00 UTC

function period(rotation, now) {
  if (rotation === 'month') {
    const d = new Date(now);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  return Math.floor((now - FIRST_MONDAY) / (7 * DAY));
}

function periodStart(rotation, p) {
  if (rotation === 'month') return Date.UTC(Math.floor(p / 12), p % 12, 1);
  return FIRST_MONDAY + p * 7 * DAY;
}

function cleanSet(input) {
  const questions = (Array.isArray(input) ? input : []).map((q) => cleanText(q, LIMITS.maxQuestion));
  if (questions.length !== 3 || questions.some((q) => !q)) return { error: 'Write all three questions.' };
  return { questions };
}

class Questions {
  constructor(data = {}, { rotation = 'week', now = Date.now() } = {}) {
    this.rotation = rotation === 'month' ? 'month' : 'week';
    this.sets = data.sets || STARTER_SETS.map((questions, i) => ({ id: i + 1, questions }));
    this.nextId = data.nextId || this.sets.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    this.paused = !!data.paused;
    // Which set is showing, and since which week (or month).
    this.pointer =
      data.pointer && data.pointer.rotation === this.rotation
        ? data.pointer
        : { setId: this.sets[0].id, period: period(this.rotation, now), rotation: this.rotation };
    // Custom questions from before sets could be managed become a set of their own.
    if (data.override && !data.sets) {
      const id = this.nextId++;
      this.sets.push({ id, questions: data.override.questions });
      this.pointer = { setId: id, period: period(this.rotation, now), rotation: this.rotation };
      this.paused = true;
    }
  }

  toJSON() {
    return { sets: this.sets, nextId: this.nextId, paused: this.paused, pointer: this.pointer };
  }

  indexOf(id) {
    return this.sets.findIndex((s) => s.id === id);
  }

  // Moves the pointer forward to `now`, one set per week or month that has passed.
  advance(now) {
    const p = period(this.rotation, now);
    let i = this.indexOf(this.pointer.setId);
    if (i === -1) i = 0;
    if (!this.paused && p > this.pointer.period) i = (i + (p - this.pointer.period)) % this.sets.length;
    this.pointer = { setId: this.sets[i].id, period: Math.max(p, this.pointer.period), rotation: this.rotation };
    return i;
  }

  current(now = Date.now()) {
    const i = this.advance(now);
    return {
      questions: this.sets[i].questions,
      setId: this.sets[i].id,
      set: i + 1,
      sets: this.sets.length,
      paused: this.paused,
      changesAt: this.paused ? null : periodStart(this.rotation, period(this.rotation, now) + 1),
      rotation: this.rotation,
    };
  }

  matches(questions, now = Date.now()) {
    const cur = this.current(now).questions;
    return Array.isArray(questions) && questions.length === cur.length && cur.every((q, i) => q === questions[i]);
  }

  // ---- Managing the list (admin) ----

  add(input) {
    const { error, questions } = cleanSet(input);
    if (error) return { error };
    if (this.sets.length >= LIMITS.maxSets) return { error: `There can be up to ${LIMITS.maxSets} sets.` };
    const set = { id: this.nextId++, questions };
    this.sets.push(set);
    return { set };
  }

  edit(id, input) {
    const i = this.indexOf(id);
    if (i === -1) return { error: 'That set no longer exists.' };
    const { error, questions } = cleanSet(input);
    if (error) return { error };
    this.sets[i].questions = questions;
    return { set: this.sets[i] };
  }

  remove(id, now = Date.now()) {
    const i = this.indexOf(id);
    if (i === -1) return { error: 'That set no longer exists.' };
    if (this.sets.length === 1) return { error: 'Keep at least one set of questions.' };
    const wasCurrent = this.advance(now) === i;
    this.sets.splice(i, 1);
    // If it was showing, the next set in the list takes over for the rest of this period.
    if (wasCurrent) this.pointer = { ...this.pointer, setId: this.sets[i % this.sets.length].id };
    return { ok: true };
  }

  move(id, by) {
    const i = this.indexOf(id);
    if (i === -1) return { error: 'That set no longer exists.' };
    const j = i + (by < 0 ? -1 : 1);
    if (j < 0 || j >= this.sets.length) return { ok: true };
    [this.sets[i], this.sets[j]] = [this.sets[j], this.sets[i]];
    return { ok: true };
  }

  // Show this set from now on; the rotation carries on from it.
  use(id, now = Date.now()) {
    if (this.indexOf(id) === -1) return { error: 'That set no longer exists.' };
    this.pointer = { setId: id, period: period(this.rotation, now), rotation: this.rotation };
    return { ok: true };
  }

  setPaused(paused, now = Date.now()) {
    this.advance(now); // settle where the rotation is before stopping or restarting it
    this.paused = !!paused;
    this.pointer = { ...this.pointer, period: period(this.rotation, now) };
    return { ok: true };
  }
}

module.exports = { Questions, STARTER_SETS, LIMITS };
