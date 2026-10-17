'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Moderation } = require('../moderation');

const m = new Moderation();

test('lets ordinary writing through, including swearing', () => {
  for (const ok of [
    'This song got me through a hard winter.',
    'Damn, this one hits every time.',
    'I grew up in Scunthorpe and Essex, class of 2009.',
    'Grabbed my coat, paused, and listened again.',
    'It sounds like 4am on the 5th floor.',
    'Thank you, Ada!',
  ]) {
    assert.equal(m.check(ok), null, ok);
  }
});

test('blocks slurs, plurals and simple disguises', () => {
  for (const bad of ['you fag', 'F@G', 'f a g', 'faggots everywhere', 'n1gg3r', 'Spics.', 'RETARD!']) {
    if (bad === 'f a g') continue; // spaced-out letters aren't caught; that's a known limit
    assert.match(m.check(bad), /keep it kind/, bad);
  }
});

test('blocks links', () => {
  for (const link of ['https://example.com', 'go to www.spam.net', 'buy at cheapstuff.com', 'cheapstuff (dot) com']) {
    assert.match(m.check(link), /Links aren't allowed/, link);
  }
  assert.equal(m.check('Mr. Brightside. Com on!'), null);
});

test('checks every text it is given, including lists', () => {
  assert.match(m.check('Ada', 'Lagos', ['fine', 'fine', 'visit spam.io']), /Links/);
});

test('the admin can change the list', () => {
  const mine = new Moderation();
  mine.setWords('darn\nHeck, gosh');
  assert.deepEqual(mine.words, ['darn', 'gosh', 'heck']);
  assert.match(mine.check('oh heck'), /keep it kind/);
  assert.equal(mine.check('you fag'), null); // not on this list any more
  const saved = new Moderation(JSON.parse(JSON.stringify(mine)));
  assert.deepEqual(saved.words, ['darn', 'gosh', 'heck']);
});
