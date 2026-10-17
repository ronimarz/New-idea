'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Questions, STARTER_SETS } = require('../questions');

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const monday = Date.UTC(2026, 9, 12); // Mon 12 Oct 2026
const three = (tag) => [`${tag} one?`, `${tag} two?`, `${tag} three?`];

test('starts with the first set and moves on every Monday, looping round', () => {
  const q = new Questions({}, { now: monday + 3 * DAY });
  const now = q.current(monday + 3 * DAY);
  assert.deepEqual(now.questions, ['Why this song?', 'What does it mean to you?', 'When did you first hear it?']);
  assert.equal(now.set, 1);
  assert.equal(now.changesAt, monday + WEEK);
  assert.deepEqual(q.current(monday + WEEK).questions, STARTER_SETS[1]);
  assert.equal(q.current(monday + WEEK * STARTER_SETS.length).set, 1);
});

test('monthly rotation turns over on the 1st', () => {
  const q = new Questions({}, { rotation: 'month', now: Date.UTC(2026, 9, 17) });
  assert.equal(q.current(Date.UTC(2026, 9, 31)).changesAt, Date.UTC(2026, 10, 1));
  assert.equal(q.current(Date.UTC(2026, 10, 1)).set, 2);
  assert.equal(q.current(Date.UTC(2027, 0, 1)).set, 4); // across the new year
});

test('keeps its place across a restart, and catches up on weeks it was off', () => {
  const q = new Questions({}, { now: monday });
  const later = new Questions(JSON.parse(JSON.stringify(q)), { now: monday + 2 * WEEK });
  assert.equal(later.current(monday + 2 * WEEK).set, 3);
});

test('add, edit, and delete sets', () => {
  const q = new Questions({}, { now: monday });
  assert.match(q.add(['Only one?']).error, /all three/);
  const { set } = q.add(three('New'));
  assert.equal(q.sets.at(-1).id, set.id);
  assert.match(q.edit(set.id, ['a', '', 'c']).error, /all three/);
  q.edit(set.id, three('Edited'));
  assert.deepEqual(q.sets.at(-1).questions, three('Edited'));
  q.remove(set.id, monday);
  assert.equal(q.sets.length, STARTER_SETS.length);
  assert.match(q.remove(999, monday).error, /no longer exists/);
});

test('editing the set on show changes the questions straight away', () => {
  const q = new Questions({}, { now: monday });
  q.edit(q.current(monday).setId, three('Fresh'));
  assert.deepEqual(q.current(monday).questions, three('Fresh'));
  assert.equal(q.matches(STARTER_SETS[0], monday), false);
});

test('reordering never changes what is showing now, only what comes next', () => {
  const q = new Questions({}, { now: monday });
  const showing = q.current(monday).setId;
  const last = q.sets.at(-1).id;
  for (let i = 0; i < 10; i++) q.move(last, -1); // bring the last set to the top
  assert.equal(q.sets[0].id, last);
  assert.equal(q.current(monday).setId, showing);
  assert.equal(q.current(monday + WEEK).setId, q.sets[2].id); // the set after the one showing
});

test('deleting the set on show hands over to the next one', () => {
  const q = new Questions({}, { now: monday });
  const second = q.sets[1].id;
  q.remove(q.current(monday).setId, monday);
  assert.equal(q.current(monday).setId, second);
  assert.equal(q.current(monday + WEEK).setId, q.sets[1].id);
});

test('cannot delete the last set', () => {
  const q = new Questions({ sets: [{ id: 1, questions: three('Only') }] }, { now: monday });
  assert.match(q.remove(1, monday).error, /at least one/);
});

test('use a set now, and the rotation carries on from it', () => {
  const q = new Questions({}, { now: monday });
  q.use(q.sets[5].id, monday + 2 * DAY);
  assert.equal(q.current(monday + 3 * DAY).set, 6);
  assert.equal(q.current(monday + WEEK).set, 7);
});

test('pausing keeps the set until the rotation is started again', () => {
  const q = new Questions({}, { now: monday });
  q.current(monday + WEEK); // set 2 is showing
  q.setPaused(true, monday + WEEK);
  const paused = q.current(monday + 5 * WEEK);
  assert.equal(paused.set, 2);
  assert.equal(paused.paused, true);
  assert.equal(paused.changesAt, null);
  q.setPaused(false, monday + 5 * WEEK);
  assert.equal(q.current(monday + 5 * WEEK).set, 2); // no jump when it restarts
  assert.equal(q.current(monday + 6 * WEEK).set, 3);
});

test('custom questions saved by the earlier version become a paused set', () => {
  const q = new Questions({ override: { questions: three('Old custom') }, start: {} }, { now: monday });
  const cur = q.current(monday);
  assert.deepEqual(cur.questions, three('Old custom'));
  assert.equal(cur.paused, true);
  assert.equal(q.sets.length, STARTER_SETS.length + 1);
});
