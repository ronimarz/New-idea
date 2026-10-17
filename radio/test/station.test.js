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

test('hearts: one per person, can be taken back, never on your own pick', () => {
  const s = new Station();
  const { track } = s.add(song('aaaaaaaaaaa'), 'picker', 0);
  assert.deepEqual(s.heart(track.id, 'fan1'), { hearts: 1, hearted: true });
  assert.deepEqual(s.heart(track.id, 'fan1'), { hearts: 1, hearted: true }); // no double counting
  s.heart(track.id, 'fan2');
  assert.deepEqual(s.heart(track.id, 'fan2', false), { hearts: 1, hearted: false });
  assert.match(s.heart(track.id, 'picker').error, /your pick/);
  assert.match(s.heart(999, 'fan1').error, /no longer/);

  const asFan = s.state(0, 'fan1').nowPlaying;
  assert.equal(asFan.hearts, 1);
  assert.equal(asFan.hearted, true);
  assert.equal(asFan.mine, false);
  const asPicker = s.state(0, 'picker').nowPlaying;
  assert.equal(asPicker.mine, true);
  assert.equal(asPicker.hearted, false);
  assert.equal(JSON.stringify(s.state(0, 'fan1')).includes('fan1'), false); // who hearted stays private
});

test('hearted songs come back more often in rotation', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = new Station({}, { random });
  // Enough songs that rotation has a real choice after skipping the 10 most recent.
  const ids = [];
  for (let i = 0; i < 15; i++) {
    ids.push(s.add(song(String(i).padStart(11, 'x'), 10), `u${i}`, 0).track.id);
  }
  for (let i = 0; i < 10; i++) s.heart(ids[0], `fan${i}`);
  const plays = {};
  for (let t = 150_000; t < 150_000 + 3000 * 10_000; t += 10_000) {
    s.tick(t);
    plays[s.playing.trackId] = (plays[s.playing.trackId] || 0) + 1;
  }
  const others = ids.slice(1).map((id) => plays[id]);
  assert.ok(plays[ids[0]] > Math.max(...others), JSON.stringify(plays));
});

test('state survives a save and reload', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0);
  s.add(song('bbbbbbbbbbb'), 'u2', 0);
  const copy = new Station(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.state(5000), s.state(5000));
  assert.equal(copy.add(song('ccccccccccc'), 'u3', 0).track.id, 3);
});
