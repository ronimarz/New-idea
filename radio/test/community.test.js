'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Chat, Notes, Presence } = require('../community');

const track = { id: 7, title: 'Harvest Moon', submitter: 'picker' };

test('chat: posts, pages, marks your own, and hides who posted', () => {
  const c = new Chat();
  assert.match(c.post({ text: '   ' }, 'a', track, 0).error, /Write something/);
  c.post({ text: 'hi from Oslo', name: 'Ada', location: 'Oslo' }, 'a', track, 0);
  assert.match(c.post({ text: 'again' }, 'a', track, 500).error, /just sent/);
  c.post({ text: 'hello!' }, 'b', null, 600);
  const all = c.since(0, 'a');
  assert.deepEqual(all.map((m) => [m.text, m.name, m.mine]), [
    ['hi from Oslo', 'Ada', true],
    ['hello!', 'Anonymous', false],
  ]);
  assert.equal(all[0].trackTitle, 'Harvest Moon');
  assert.equal(JSON.stringify(all).includes('"key"'), false);
  assert.deepEqual(c.since(all[0].id, 'a').map((m) => m.text), ['hello!']);
});

test('chat: admin removal', () => {
  const c = new Chat();
  const { message } = c.post({ text: 'one' }, 'troll', null, 0);
  c.post({ text: 'two' }, 'troll', null, 5000);
  c.post({ text: 'kind' }, 'nice', null, 5000);
  assert.equal(c.remove(message.id), true);
  assert.equal(c.removeByKey('troll'), 1);
  assert.deepEqual(c.since(0).map((m) => m.text), ['kind']);
});

test('notes: only the picker sees them, one per song per sender', () => {
  const n = new Notes();
  assert.match(n.send(track, { text: 'thanks' }, 'picker', 0).error, /your own pick/);
  assert.match(n.send(null, { text: 'thanks' }, 'fan', 0).error, /no longer/);
  assert.match(n.send(track, { text: ' ' }, 'fan', 0).error, /few words/);
  assert.ok(n.send(track, { text: 'This got me through my shift.', name: 'Kim', location: 'Seoul' }, 'fan', 0).note);
  assert.match(n.send(track, { text: 'again' }, 'fan', 60_000).error, /already sent/);

  assert.deepEqual(n.inbox('fan'), { unread: 0, notes: [] });
  const box = n.inbox('picker');
  assert.equal(box.unread, 1);
  assert.equal(box.notes[0].text, 'This got me through my shift.');
  assert.equal(box.notes[0].trackTitle, 'Harvest Moon');
  assert.equal(JSON.stringify(box).includes('fan'), false);
  assert.deepEqual(n.sentFor('fan'), [7]);

  n.markRead('picker');
  assert.equal(n.inbox('picker').unread, 0);
  assert.equal(n.hide(box.notes[0].id, 'fan'), false); // not theirs to clear
  assert.equal(n.hide(box.notes[0].id, 'picker'), true);
  assert.equal(n.inbox('picker').notes.length, 0);
});

test('notes: rate limited and removable for a banned sender', () => {
  const n = new Notes();
  const other = { id: 8, title: 'Other', submitter: 'picker' };
  n.send(track, { text: 'one' }, 'fan', 0);
  assert.match(n.send(other, { text: 'two' }, 'fan', 1000).error, /just sent/);
  assert.ok(n.send(other, { text: 'two' }, 'fan', 20_000).note);
  assert.equal(n.removeByKey('fan'), 2);
});

test('presence: counts recent listeners and groups their places', () => {
  const p = new Presence();
  p.ping('a', 'Lagos', 0);
  p.ping('b', 'lagos', 1000);
  p.ping('c', 'Oslo', 2000);
  p.ping('d', '', 3000);
  p.ping('old', 'Paris', -60_000);
  assert.deepEqual(p.summary(5000), { count: 4, places: ['Lagos', 'Oslo'], morePlaces: 0 });
});
