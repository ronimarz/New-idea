'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Station, parseYouTubeId, looksNonEnglish } = require('../station');

const song = (videoId, duration = 60, extra = {}) => ({
  videoId,
  duration,
  title: `Song ${videoId}`,
  answers: [
    'The drums come in late and the whole song finally exhales.',
    'It means slowing down, even when everything else is loud.',
    'On a long drive home from my first job, windows down.',
  ],
  name: 'Sam',
  location: 'Lagos, Nigeria',
  language: 'english',
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
  const good = song('x').answers;
  assert.match(s.add(song('aaaaaaaaaaa', 60, { answers: undefined }), 'u').error, /Answer “Why this song\?”/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { answers: [good[0], 'Great song!', good[2]] }), 'u').error,
    /Say a little more for “What does it mean to you\?” \(at least 40/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { answers: [good[0], good[1], '   '] }), 'u').error, /Answer “When did/);
  // Padding with spaces doesn't count toward the minimum.
  assert.match(s.add(song('aaaaaaaaaaa', 60, { answers: [`Great${' '.repeat(60)}song`, good[1], good[2]] }), 'u').error,
    /at least 40/);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { location: '  ' }), 'u').error, /where you're listening/);
});

test('limits songs waiting per person', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0); // starts playing, not queued
  s.add(song('bbbbbbbbbbb'), 'u1', 0);
  s.add(song('ccccccccccc'), 'u1', 0);
  s.add(song('ddddddddddd'), 'u1', 0);
  assert.match(s.add(song('eeeeeeeeeee'), 'u1', 0).error, /already have 3/);
  assert.ok(s.add(song('eeeeeeeeeee'), 'u2', 0).track);
});

test('a song already on the station gets the new pick instead of a copy', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 60), 'u1', 0); // on air
  const b = s.add(song('bbbbbbbbbbb', 60, { name: 'Ada' }), 'u2', 0).track; // queued
  const joined = s.add(song('bbbbbbbbbbb', 60, { name: 'Kim', location: 'Seoul' }), 'u3', 1000);
  assert.equal(joined.joined, true);
  assert.equal(joined.track.id, b.id);
  assert.equal(s.tracks.length, 2);
  assert.deepEqual(s.queue, [b.id]); // keeps its place, isn't queued twice
  const next = s.state(1000).upNext[0];
  assert.deepEqual(next.picks.map((p) => p.name), ['Kim', 'Ada']); // newest pick leads
  assert.equal(next.picks[0].location, 'Seoul');
});

test('a pick of a song that already played adds the answers but never queues it again', () => {
  const s = new Station();
  const a = s.add(song('aaaaaaaaaaa', 10), 'u1', 0).track;
  s.add(song('bbbbbbbbbbb', 60), 'u2', 0);
  s.tick(15_000); // a has played; b is on air
  const r = s.add(song('aaaaaaaaaaa', 10), 'u3', 15_000);
  assert.equal(r.joined, true);
  assert.deepEqual(s.queue, []);
  assert.equal(s.byId(a.id).picks.length, 2);
});

test('joining a song does not count toward the songs-waiting limit', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u0', 0); // on air
  for (const v of ['bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']) s.add(song(v), 'other', 0);
  for (const v of ['eeeeeeeeeee', 'fffffffffff', 'ggggggggggg']) s.add(song(v), 'u1', 0);
  assert.ok(s.add(song('bbbbbbbbbbb'), 'u1', 0).joined); // u1 already has 3 waiting
});

test('lookup says whether a song is already on the station', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 60, { title: 'Holocene' }), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 60), 'u2', 0);
  assert.deepEqual(s.lookup('aaaaaaaaaaa'), { exists: true, title: 'Holocene', picks: 1, onAir: true, position: 0 });
  assert.equal(s.lookup('bbbbbbbbbbb').position, 1);
  assert.deepEqual(s.lookup('zzzzzzzzzzz'), { exists: false });
});

test('a pick of the song on air joins it without queueing it again', () => {
  const s = new Station();
  const a = s.add(song('aaaaaaaaaaa', 60), 'u1', 0).track;
  s.add(song('aaaaaaaaaaa', 60, { name: 'Kim' }), 'u2', 1000);
  assert.deepEqual(s.queue, []);
  assert.equal(s.state(1000).nowPlaying.picks[0].name, 'Kim');
  assert.equal(s.playing.trackId, a.id);
});

test('one pick per person per song', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0);
  assert.match(s.add(song('aaaaaaaaaaa'), 'u1', 1000).error, /already picked this song/);
});

test('admin can remove one pick; the song goes when its last pick does', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 60), 'u0', 0);
  const t = s.add(song('bbbbbbbbbbb', 60), 'u1', 0).track;
  s.add(song('bbbbbbbbbbb', 60), 'u2', 0);
  const [p1, p2] = t.picks;
  assert.equal(s.removePick(t.id, p1.id), true);
  assert.equal(s.byId(t.id).picks.length, 1);
  s.removePick(t.id, p2.id);
  assert.equal(s.byId(t.id), null);
  assert.deepEqual(s.queue, []);
});

test("banning removes only that person's picks", () => {
  const s = new Station();
  const t = s.add(song('aaaaaaaaaaa', 60), 'troll', 0).track;
  s.add(song('aaaaaaaaaaa', 60), 'nice', 0);
  s.add(song('bbbbbbbbbbb', 60), 'troll', 0);
  assert.equal(s.removeBySubmitter('troll', 0), 2);
  assert.equal(s.tracks.length, 1);
  assert.equal(s.byId(t.id).picks.length, 1);
});

test('duplicates saved by the earlier version are merged into one song', () => {
  const old = (id, submitter, name) => ({
    id, videoId: 'aaaaaaaaaaa', duration: 60, title: 'Same', name, submitter,
    answers: [{ question: 'Why this song?', answer: `${name}'s reason` }], addedAt: id, plays: 1, hearts: [`h${id}`],
  });
  const s = new Station({
    tracks: [old(1, 'u1', 'Ada'), old(2, 'u2', 'Kim'), { ...old(3, 'u3', 'Jin'), videoId: 'bbbbbbbbbbb' }],
    queue: [2, 3, 1],
    history: [1, 2],
    playing: { trackId: 2, startedAt: 0 },
    nextId: 4,
  });
  assert.equal(s.tracks.length, 2);
  assert.deepEqual(s.byId(1).picks.map((p) => p.name), ['Ada', 'Kim']);
  assert.deepEqual(s.byId(1).hearts, ['h1', 'h2']);
  assert.equal(s.byId(1).plays, 2);
  assert.deepEqual(s.queue, [1, 3]);
  assert.deepEqual(s.history, [1, 1]);
  assert.equal(s.playing.trackId, 1);
  // New picks get fresh ids after the migrated ones.
  const p = s.add(song('ccccccccccc'), 'u9', 0).pick;
  assert.ok(p.id > Math.max(...s.tracks.flatMap((t) => t.picks.map((x) => x.id)).filter((id) => id !== p.id)));
});

test('cleans text and hides who submitted', () => {
  const s = new Station();
  const messy = 'so\n\ngood '.repeat(10);
  s.add(song('aaaaaaaaaaa', 60, { name: '', answers: [messy, messy, messy], title: 'x'.repeat(500) }), 'secret', 0);
  const np = s.state(0).nowPlaying;
  assert.equal(np.picks[0].name, 'Anonymous');
  assert.equal(np.picks[0].location, 'Lagos, Nigeria');
  assert.deepEqual(np.picks[0].answers[0], { question: 'Why this song?', answer: 'so good '.repeat(10).trim() });
  assert.equal(np.title.length, 200);
  assert.equal(JSON.stringify(np).includes('secret'), false);
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

// Plays `count` past picks back to back with nothing queued; returns the ids in order.
function playRotation(s, start, count) {
  const order = [];
  let t = start;
  for (let i = 0; i < count; i++) {
    s.tick(t);
    order.push(s.playing.trackId);
    t = s.playing.startedAt + s.byId(s.playing.trackId).duration * 1000;
  }
  return order;
}

function seeded(seed = 1) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

test('every song plays once before any song repeats', () => {
  const s = new Station({}, { random: seeded() });
  for (let i = 0; i < 12; i++) s.add(song(String(i).padStart(11, 'x'), 10 + i), `u${i}`, 0);
  // The first round is the 12 new songs playing from the queue; count from the end of it.
  const order = playRotation(s, s.roundLength() * 1000, 12 * 5);
  for (let r = 0; r < 5; r++) {
    const round = order.slice(r * 12, r * 12 + 12);
    assert.equal(new Set(round).size, 12, `round ${r} repeats a song: ${round}`);
  }
  // Rounds are shuffled differently each time.
  assert.notDeepEqual(order.slice(0, 12), order.slice(12, 24));
});

test('a new round never starts with a song that just played', () => {
  const s = new Station({}, { random: seeded(7) });
  for (let i = 0; i < 6; i++) s.add(song(String(i).padStart(11, 'x'), 10), `u${i}`, 0);
  const order = playRotation(s, s.roundLength() * 1000, 6 * 20);
  for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1]);
  for (let r = 1; r < 20; r++) {
    const endOfLast = order.slice(r * 6 - 3, r * 6);
    assert.ok(!endOfLast.includes(order[r * 6]), `round ${r} starts with a song from the end of the last`);
  }
});

test('hearts never make a song repeat sooner', () => {
  const s = new Station({}, { random: seeded(3) });
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(s.add(song(String(i).padStart(11, 'x'), 10), `u${i}`, 0).track.id);
  for (let i = 0; i < 10; i++) s.heart(ids[0], `fan${i}`);
  const order = playRotation(s, s.roundLength() * 1000, 8 * 10);
  assert.equal(order.filter((id) => id === ids[0]).length, 10);
});

test('the round length is the time to play every song once', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 200), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 100), 'u2', 0);
  assert.equal(s.roundLength(), 300);
});

test('only accepts the languages the station is set up for', () => {
  const s = new Station();
  assert.match(s.add(song('aaaaaaaaaaa', 60, { language: 'spanish' }), 'u', 0).error,
    /only plays songs that are in English or instrumental\./);
  assert.match(s.add(song('aaaaaaaaaaa', 60, { language: undefined }), 'u', 0).error, /only plays/);
  assert.equal(s.add(song('aaaaaaaaaaa', 60, { language: 'instrumental' }), 'u', 0).track.language, 'instrumental');

  const englishOnly = new Station({}, { languages: ['english'] });
  assert.match(englishOnly.add(song('aaaaaaaaaaa', 60, { language: 'instrumental' }), 'u', 0).error,
    /only plays songs that are in English\./);
});

test('flags titles that look like they are not in English, without blocking them', () => {
  assert.equal(looksNonEnglish('Bohemian Rhapsody'), false);
  assert.equal(looksNonEnglish('Beyoncé – Déjà Vu'), false);
  assert.equal(looksNonEnglish('IU - 밤편지'), true);
  assert.equal(looksNonEnglish('Кино – Группа крови'), true);
  assert.equal(looksNonEnglish('BTS (방탄소년단) Dynamite Official MV'), false);
  const s = new Station();
  assert.equal(s.add(song('aaaaaaaaaaa', 60, { title: '夜に駆ける' }), 'u', 0).track.flag, 'Title may not be in English');
  assert.equal(s.add(song('bbbbbbbbbbb', 60, { title: 'Clair de Lune' }), 'u2', 0).track.flag, undefined);
});

test('tells players what comes next, including past picks', () => {
  const s = new Station({}, { random: () => 0 });
  s.add(song('aaaaaaaaaaa', 60), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 30), 'u2', 0);
  let st = s.state(1000);
  assert.equal(st.next.videoId, 'bbbbbbbbbbb');
  assert.equal(st.next.startsAt, 60_000);
  assert.equal(st.next.replay, false);

  s.tick(61_000); // b is on air, queue is empty: the next song is a past pick, chosen now
  st = s.state(61_000);
  assert.equal(st.next.videoId, 'aaaaaaaaaaa');
  assert.equal(st.next.replay, true);
  assert.equal(st.next.startsAt, 90_000);
  s.tick(91_000);
  assert.equal(s.state(91_000).nowPlaying.videoId, 'aaaaaaaaaaa'); // and that's what actually plays
});

test('a new submission still goes ahead of an already chosen past pick', () => {
  const s = new Station({}, { random: () => 0 });
  s.add(song('aaaaaaaaaaa', 60), 'u1', 0);
  s.add(song('bbbbbbbbbbb', 30), 'u2', 0);
  s.tick(61_000);
  assert.equal(s.state(61_000).next.videoId, 'aaaaaaaaaaa');
  s.add(song('ccccccccccc', 30), 'u3', 62_000);
  assert.equal(s.state(62_000).next.videoId, 'ccccccccccc');
  s.tick(91_000);
  assert.equal(s.playing.trackId, 3);
});

test('stores each answer with the question it was asked, so picks outlive the questions', () => {
  const s = new Station();
  const asked = ['Q one?', 'Q two?', 'Q three?'];
  const { pick } = s.add(song('aaaaaaaaaaa'), 'u', 0, asked);
  assert.deepEqual(pick.answers.map((a) => a.question), asked);
});

test('picks from before the questions still show their blurb', () => {
  const s = new Station({ tracks: [{ id: 1, videoId: 'aaaaaaaaaaa', duration: 60, title: 'Old', blurb: 'An old blurb.', name: 'A' }] });
  s.tick(0);
  assert.deepEqual(s.state(0).nowPlaying.picks[0].answers, [{ question: 'Why should people hear this?', answer: 'An old blurb.' }]);
});

test('state survives a save and reload', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa'), 'u1', 0);
  s.add(song('bbbbbbbbbbb'), 'u2', 0);
  const copy = new Station(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.state(5000), s.state(5000));
  assert.equal(copy.add(song('ccccccccccc'), 'u3', 0).track.id, 3);
});

test('admin can remove a song, even the one on air', () => {
  const s = new Station();
  const a = s.add(song('aaaaaaaaaaa', 60), 'u1', 0).track;
  const b = s.add(song('bbbbbbbbbbb', 60), 'u2', 0).track;
  assert.equal(s.remove(a.id, 5000), true);
  assert.equal(s.playing.trackId, b.id);
  assert.equal(s.playing.startedAt, 5000);
  assert.equal(s.byId(a.id), null);
  assert.equal(s.remove(a.id, 5000), false);
});

test('admin can skip and remove everything from one person', () => {
  const s = new Station();
  s.add(song('aaaaaaaaaaa', 60), 'troll', 0);
  s.add(song('bbbbbbbbbbb', 60), 'troll', 0);
  const c = s.add(song('ccccccccccc', 60), 'nice', 0).track;
  assert.equal(s.removeBySubmitter('troll', 1000), 2);
  assert.equal(s.playing.trackId, c.id);
  assert.deepEqual(s.queue, []);
  assert.equal(s.skip(2000), true);
  assert.equal(s.playing.trackId, c.id); // the only song left comes round again
  assert.equal(s.playing.startedAt, 2000);
});
