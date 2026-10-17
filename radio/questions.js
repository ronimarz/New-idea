'use strict';

// The three questions people answer when they add a song. They rotate on their own every
// week or month, and the admin can set custom ones at any time.

const { cleanText, DEFAULT_QUESTIONS } = require('./station');

const SETS = [
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
    "What would you tell someone hearing it for the first time?",
  ],
  [
    'What were you doing the last time this song stopped you in your tracks?',
    'What feeling does it give words to?',
    'Why this song, out of all the songs you love?',
  ],
];

const LIMITS = { maxQuestion: 140 };
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

class Questions {
  constructor(data = {}, { rotation = 'week', sets = SETS, now = Date.now() } = {}) {
    this.rotation = rotation === 'month' ? 'month' : 'week';
    this.sets = sets;
    this.override = data.override || null;
    // Remember when the rotation began so it starts at the first set, not a random one.
    this.start =
      data.start && data.start.rotation === this.rotation
        ? data.start
        : { rotation: this.rotation, period: period(this.rotation, now) };
  }

  toJSON() {
    return { override: this.override, start: this.start };
  }

  current(now = Date.now()) {
    if (this.override) {
      return { questions: this.override.questions, custom: true, changesAt: null, rotation: this.rotation };
    }
    const p = period(this.rotation, now);
    const index = (((p - this.start.period) % this.sets.length) + this.sets.length) % this.sets.length;
    return {
      questions: this.sets[index],
      custom: false,
      set: index + 1,
      sets: this.sets.length,
      changesAt: periodStart(this.rotation, p + 1),
      rotation: this.rotation,
    };
  }

  matches(questions, now = Date.now()) {
    const cur = this.current(now).questions;
    return Array.isArray(questions) && questions.length === cur.length && cur.every((q, i) => q === questions[i]);
  }

  setCustom(input, now = Date.now()) {
    const questions = (Array.isArray(input) ? input : []).map((q) => cleanText(q, LIMITS.maxQuestion));
    if (questions.length !== 3 || questions.some((q) => !q)) return { error: 'Write all three questions.' };
    this.override = { questions, since: now };
    return { questions };
  }

  // Go back to the automatic rotation.
  clearCustom() {
    this.override = null;
  }
}

module.exports = { Questions, SETS, LIMITS };
