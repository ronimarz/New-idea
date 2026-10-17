'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Station, parseYouTubeId } = require('../station');

const song = (videoId, duration = 60, extra = {}) => ({
  videoId,
  duration,
  title: `Song ${videoId}`,
  blurb: 'The drums come in late and it feels like the whole song finally exhales. I play it on every long drive home.',
  name: 'Sam',
  location: 'Lagos, Nigeria',
  ...extra,
});

test('parses common YouTube link shapes', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=30s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=x`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
  ]) {
    assert.equal(parseYouTubeId(url), id, url);
  }
  for (const bad of ['', 'hello', 'https://vimeo.com/123', `https://evil.com/watch?v=${id}`, null]) {
    assert.equal(parseYouTubeId(bad), null, String(bad));
  }
});

test('first song starts immediately, later ones queue', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 1000);
  s.add(song('bbbbbbbbbbb'), 'u2', 2000);
  const st = s.state(2000);
  assert.equal(st.nowPlaying.videoId, 'aaaaaaaaaaa');
  assert.equal(st.nowPlaying.startedAt, 1000);
  assert.deepEqual(st.upNext.map((t) => t.videoId), ['bbbbbbbbbbb']);
});

test('songs play back to back with no gap', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 60), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 30), 'u2', 0);
  s.tick(75_000);
  assert.equal(s.state(75_000).nowPlaying.videoId, 'bbbbbbbbbbb');
  assert.equal(s.playing.startedAt, 60_000);
});

test('keeps playing past picks when the queue is empty', () => {
  const s = new Station({}, { random: () => 0 });
  s.add(song('aaaaaaaaaaa', 10), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 10), 'u2', 0);
  s.tick(25_000); // a and b have both played; rotation picks one that wasn't just played
  const st = s.state(25_000);
  assert.equal(st.nowPlaying.videoId, 'aaaaaaaaaaa');
  assert.equal(st.queueLength, 0);
});

test('rotation does not repeat the song that just played', () => {
  const s = new Station({}, { random: () => 0.99 });
  s.add(song('aaaaaaaaaaa', 10), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 10), 'u2', 0);
  s.add(song('ccccccccccc', 10), 'u3', 0);
  let last = null;
  for (let t = 0; t < 300_000; t += 10_000) {
    s.tick(t);
    assert.notEqual(s.playing.trackId, last);
    last = s.playing.trackId;
  }
});

test('new submissions jump ahead of rotation', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 10), 'u1', 0);
  s.tick(15_000); // now replaying a
  s.add(song('bbbbbbbbbbb', 10), 'u2', 15_000);
  s.tick(20_000);
  assert.equal(s.state(20_000).nowPlaying.videoId, 'bbbbbbbbbbb');
});

test('after a long outage the station restarts at the current time', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 10), 'u1', 0);
  const later = 10 * 24 * 3600 * 1000;
  s.tick(later);
  assert.equal(s.playing.startedAt, later);
});

test('rejects bad submissions', () => {
  const s = new Station();
  assert.match(s.add(song('nope'), 'u').error, /YouTube link/);
  assert.match(s.add(song('aaaaaaaaaaa', 0), 'u').error, /how long/);
  assert.match(s.add(song('aaaaaaaaaaa', 99999), 'u').error, /up to 15 minutes/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { blurb: '   ' }), 'u').error, /why/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { blurb: 'Great song!' }), 'u').error, /at least 100/);
  // Padding with spaces doesn't count toward the minimum.
  assert.match(s.add(song('aaaaaaaaaaa', 60, { blurb: `Great${' '.repeat(120)}song` }), 'u').error, /at least 100/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { location: '  ' }), 'u').error, /where you're listening/);
});

test('blocks duplicates in the queue and limits songs per person', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0); // starts playing, not queued
  s.add(song('bbbbbbbbbbb'), 'u1', 0);
  assert.match(s.add(song('bbbbbbbbbbb'), 'u2', 0).error, /already in the queue/);
  s.add(song('ccccccccccc'), 'u1', 0);
  s.add(song('ddddddddddd'), 'u1', 0);
  assert.match(s.add(song('eeeeeeeeeee'), 'u1', 0).error, /already have 3/);
  assert.ok(s.add(song('eeeeeeeeeee'), 'u2', 0).track);
});

test('cleans text and hides who submitted', () => {
  const s = new Station();
  const blurb = 'so\n\ngood '.repeat(20);
  s.add(song('aaaaaaaaaaa', 60, { name: '', blurb, title: 'x'.repeat(500) }), 'secret', 0);
  const np = s.state(0).nowPlaying;
  assert.equal(np.name, 'Anonymous');
  assert.equal(np.location, 'Lagos, Nigeria');
  assert.equal(np.blurb, 'so good '.repeat(20).trim());
  assert.equal(np.title.length, 200);
  assert.equal('submitter' in np, false);
});

test('state survives a save and reload', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0);
  s.add(song('bbbbbbbbbbb'), 'u2', 0);
  const copy = new Station(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.state(5000), s.state(5000));
  assert.equal(copy.add(song('ccccccccccc'), 'u3', 0).track.id, 3);
});
