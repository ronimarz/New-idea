'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Questions, SETS } = require('../questions');

const DAY = 24 * 3600 * 1000;
const monday = Date.UTC(2026, 9, 12); // Mon 12 Oct 2026

test('starts with the first set and moves on every Monday', () => {
  const q = new Questions({}, { now: monday + 3 * DAY });
  const now = q.current(monday + 3 * DAY);
  assert.deepEqual(now.questions, ['Why this song?', 'What does it mean to you?', 'When did you first hear it?']);
  assert.equal(now.set, 1);
  assert.equal(now.changesAt, monday + 7 * DAY);
  assert.deepEqual(q.current(monday + 7 * DAY).questions, SETS[1]);
  assert.deepEqual(q.current(monday + 7 * DAY * SETS.length).questions, SETS[0]); // loops round
});

test('monthly rotation turns over on the 1st', () => {
  const q = new Questions({}, { rotation: 'month', now: Date.UTC(2026, 9, 17) });
  assert.equal(q.current(Date.UTC(2026, 9, 31)).set, 1);
  assert.equal(q.current(Date.UTC(2026, 9, 31)).changesAt, Date.UTC(2026, 10, 1));
  assert.equal(q.current(Date.UTC(2026, 10, 1)).set, 2);
  assert.equal(q.current(Date.UTC(2027, 0, 1)).set, 4); // across the new year
});

test('the rotation keeps its place across a restart', () => {
  const q = new Questions({}, { now: monday });
  const saved = JSON.parse(JSON.stringify(q));
  const later = new Questions(saved, { now: monday + 14 * DAY });
  assert.equal(later.current(monday + 14 * DAY).set, 3);
});

test('the admin can set custom questions and go back to the rotation', () => {
  const q = new Questions({}, { now: monday });
  assert.match(q.setCustom(['One?', 'Two?']).error, /all three/);
  assert.match(q.setCustom(['One?', '  ', 'Three?']).error, /all three/);
  q.setCustom(['What song saved you this year?', 'From what?', 'Who should hear it?'], monday);
  const cur = q.current(monday + 30 * DAY);
  assert.equal(cur.custom, true);
  assert.equal(cur.changesAt, null);
  assert.equal(q.matches(['What song saved you this year?', 'From what?', 'Who should hear it?'], monday), true);
  q.clearCustom();
  assert.equal(q.current(monday).custom, false);
});

test('matches only the questions shown right now', () => {
  const q = new Questions({}, { now: monday });
  assert.equal(q.matches(SETS[0], monday), true);
  assert.equal(q.matches(SETS[0], monday + 7 * DAY), false);
  assert.equal(q.matches(undefined, monday), false);
});
