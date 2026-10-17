'use strict';

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const CHAT_POLL_MS = 2500;
const DRIFT_TOLERANCE_SEC = 3;
const MIN_ANSWER = 40;
const MAX_ANSWER = 240;

let state = null;
let clockOffset = 0; // serverTime - local time
let player = null;
let playerReady = false;
let tunedIn = remembered('tunedIn') === '1'; // returning listeners start playing on their own
let audible = false;
let mutedForPreview = false;
let needsClick = false;
let autoplayTimer = null;
let loadedKey = null; // which airing is loaded; the same song can come round again
let endTimer = null;

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked; the page still works, it just won't remember.
  }
}

// Name and location are remembered in this browser so people only type them once.
function me() {
  try {
    return JSON.parse(localStorage.getItem('me')) || { name: '', location: '' };
  } catch {
    return { name: '', location: '' };
  }
}

function rememberMe(name, location) {
  try {
    localStorage.setItem('me', JSON.stringify({ name: name.trim(), location: location.trim() }));
  } catch {
    // Private mode or storage blocked; nothing to remember then.
  }
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function serverNow() {
  return Date.now() + clockOffset;
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function parseYouTubeId(input) {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([^/]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// ---- Station state -------------------------------------------------------

async function fetchState() {
  try {
    const sent = Date.now();
    const from = encodeURIComponent(me().location);
    const res = await fetch(`/api/state?from=${from}`, { cache: 'no-store' });
    const data = await res.json();
    clockOffset = data.serverTime - (sent + Date.now()) / 2;
    keepLocalHandoff(data);
    state = data;
    render();
    syncPlayer();
  } catch {
    // Network hiccup; the next poll will catch up.
  }
}

function elapsedSec() {
  const np = state && state.nowPlaying;
  return np ? (serverNow() - np.startedAt) / 1000 : 0;
}

function langTag(t) {
  return t.language === 'instrumental' ? ' · instrumental' : '';
}

// `p` is one person's pick of a song: their name, where they are, and their answers.
function pickedBy(p) {
  return p.location ? `${p.name} in ${p.location}` : p.name;
}

// The newest pick leads; it's usually why the song is playing now.
function lead(t) {
  return t.picks[0];
}

function pickedBySummary(t) {
  const others = t.picks.length - 1;
  return pickedBy(lead(t)) + (others ? ` + ${others} ${others === 1 ? 'other' : 'others'}` : '');
}

// Hearts are the only reaction. There is deliberately no way to count against a song.
function heartControl(t) {
  if (t.mine) {
    const span = document.createElement('span');
    span.className = 'mine';
    span.textContent = t.hearts
      ? `Your pick · ♥ ${t.hearts} ${t.hearts === 1 ? 'person loves' : 'people love'} it`
      : 'Your pick';
    return span;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'heart';
  btn.setAttribute('aria-pressed', String(t.hearted));
  btn.setAttribute('aria-label', t.hearted ? 'Remove your heart' : 'Love this pick');
  btn.title = t.hearted ? 'You love this pick' : 'Love this pick';
  btn.textContent = t.hearts ? `♥ ${t.hearts}` : '♥';
  btn.addEventListener('click', () => toggleHeart(t));
  return btn;
}

async function toggleHeart(t) {
  const on = !t.hearted;
  const apply = (hearted, hearts) => {
    for (const x of [state.nowPlaying, ...state.upNext, ...state.recent]) {
      if (x && x.id === t.id) Object.assign(x, { hearted, hearts });
    }
    render();
  };
  const before = { hearted: t.hearted, hearts: t.hearts };
  apply(on, t.hearts + (on ? 1 : -1));
  try {
    const res = await fetch(`/api/tracks/${t.id}/heart`, { method: on ? 'PUT' : 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    apply(body.hearted, body.hearts);
  } catch {
    apply(before.hearted, before.hearts);
  }
}

// A private thank-you to one person who picked the song.
function noteControl(t, p) {
  if (p.mine) return null;
  if (state.thanked.includes(p.id)) {
    const span = document.createElement('span');
    span.className = 'sent';
    span.textContent = '✉ Sent';
    return span;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'heart';
  btn.textContent = '✉ Thank';
  btn.title = `Send ${p.name} a private note`;
  btn.addEventListener('click', () => openNote(t, p));
  return btn;
}

function actions(...controls) {
  const div = document.createElement('div');
  div.className = 'actions';
  div.append(...controls.filter(Boolean));
  return div;
}

// The full set of answers, as shown for the song on air.
function answerList(answers) {
  return answers.flatMap(({ question, answer }) => {
    const dt = document.createElement('dt');
    dt.textContent = question;
    const dd = document.createElement('dd');
    dd.textContent = answer;
    return [dt, dd];
  });
}

// The page is redrawn on every update, so remember which parts someone has opened.
const openItems = new Set();

function openable(key, summaryContent, body) {
  const details = document.createElement('details');
  details.open = openItems.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) openItems.add(key);
    else openItems.delete(key);
  });
  const summary = document.createElement('summary');
  summary.append(...summaryContent);
  details.append(summary, ...body);
  return details;
}

// One person's pick: who, their answers, and a way to thank them.
function pickBody(t, p) {
  const dl = document.createElement('dl');
  dl.className = 'answers';
  dl.append(...answerList(p.answers));
  return [dl, actions(noteControl(t, p))];
}

// In the lists: the song and who picked it; everyone's answers open on a click.
function trackItem(t, list) {
  const li = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = t.title;
  const body = t.picks.flatMap((p) => {
    const who = document.createElement('div');
    who.className = 'pick-who';
    who.textContent = pickedBy(p);
    return [who, ...pickBody(t, p)];
  });
  li.append(openable(`${list}:${t.id}`, [title, ` · ${pickedBySummary(t)}`], [...body, actions(heartControl(t))]));
  return li;
}

// Under the song on air: everyone else who picked it.
function renderAlso(np) {
  const others = np.picks.slice(1);
  $('np-also').hidden = !others.length;
  $('np-also-list').replaceChildren(
    ...others.map((p) => openable(`np:${p.id}`, [pickedBy(p)], pickBody(np, p)))
  );
}

function render() {
  const np = state.nowPlaying;
  $('np-empty').hidden = !!np;
  $('np-info').hidden = !np;
  $('tune-in').hidden = !np || audible || (tunedIn && !needsClick);
  if (np) {
    $('np-title').textContent = np.title;
    $('np-name').textContent = lead(np).name;
    $('np-from').textContent = lead(np).location ? ` in ${lead(np).location}` : '';
    $('np-lang').textContent = langTag(np);
    const nx = state.next;
    $('np-next').textContent = nx
      ? `Next: ${nx.title}`
      : '';
    $('np-answers').replaceChildren(...answerList(lead(np).answers));
    $('np-heart').replaceChildren(...[heartControl(np), noteControl(np, lead(np))].filter(Boolean));
    renderAlso(np);
    $('np-total').textContent = fmt(np.duration);
    document.title = `♪ ${np.title} · Open Air Radio`;
  } else {
    document.title = 'Open Air Radio';
  }

  $('up-next').replaceChildren(...state.upNext.map((t) => trackItem(t, 'next')));
  $('next-empty').hidden = state.upNext.length > 0 || !np;
  $('queue-count').textContent = state.queueLength ? `(${state.queueLength})` : '';
  $('recent').replaceChildren(...state.recent.map((t) => trackItem(t, 'recent')));
  $('recent-empty').hidden = state.recent.length > 0;
  renderLanguages();
  renderListeners();
  renderQuestions(state.questions);
  renderInbox();
}

function renderListeners() {
  const { count, places, morePlaces } = state.listeners;
  let text = `${count} listening`;
  if (places.length) {
    text += ` from ${places.join(', ')}`;
    if (morePlaces) text += ` and ${morePlaces} more ${morePlaces === 1 ? 'place' : 'places'}`;
  }
  $('listening').textContent = text;
}

// ---- Thank-you notes ---------------------------------------------------------

const freshNotes = new Set(); // notes that were unread when this page first saw them
let markingRead = false;

function renderInbox() {
  const { notes, unread } = state.inbox;
  for (const n of notes) if (!n.read) freshNotes.add(n.id);
  $('inbox').hidden = notes.length === 0;
  $('inbox-new').textContent = freshNotes.size ? `${freshNotes.size} new` : '';
  $('inbox-list').replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement('li');
      if (freshNotes.has(n.id)) li.className = 'fresh';
      const text = document.createElement('div');
      text.className = 'note-text';
      text.textContent = n.text;
      const meta = document.createElement('div');
      meta.className = 't-meta';
      meta.textContent = `${n.location ? `${n.name} in ${n.location}` : n.name} · about “${n.trackTitle}”`;
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'link';
      hide.textContent = 'Clear';
      hide.addEventListener('click', async () => {
        await fetch(`/api/notes/${n.id}`, { method: 'DELETE' });
        freshNotes.delete(n.id);
        fetchState();
      });
      li.append(text, meta, hide);
      return li;
    })
  );
  // They've seen them now; the "new" highlight stays until they reload.
  if (unread && !markingRead) {
    markingRead = true;
    fetch('/api/notes/read', { method: 'POST' }).finally(() => (markingRead = false));
  }
}

let noteTrack = null;
let notePick = null;

function openNote(t, p) {
  noteTrack = t;
  notePick = p;
  const who = me();
  $('note-heading').textContent = `Thank ${p.name} for “${t.title}”`;
  $('note-private').textContent = `Only ${p.name} will see this.`;
  $('n-text').value = '';
  $('n-name').value = who.name;
  $('n-location').value = who.location;
  $('note-msg').textContent = '';
  $('note-dialog').showModal();
  $('n-text').focus();
}

async function onNoteSubmit(e) {
  e.preventDefault();
  const name = $('n-name').value;
  const location = $('n-location').value;
  rememberMe(name, location);
  $('note-send').disabled = true;
  try {
    const res = await fetch(`/api/tracks/${noteTrack.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('n-text').value, name, location, pick: notePick.id }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    state.thanked.push(notePick.id);
    render();
    $('note-dialog').close();
  } catch (err) {
    $('note-msg').textContent = err.message;
  } finally {
    $('note-send').disabled = false;
  }
}

// ---- Live chat -----------------------------------------------------------------

let lastChatId = 0;
let lastChatTrack = null;

function chatLine(m) {
  const items = [];
  if (m.trackId && m.trackId !== lastChatTrack) {
    const divider = document.createElement('li');
    divider.className = 'chat-song';
    divider.textContent = `♪ ${m.trackTitle}`;
    items.push(divider);
  }
  lastChatTrack = m.trackId;
  const li = document.createElement('li');
  if (m.mine) li.className = 'mine-msg';
  const meta = document.createElement('div');
  meta.className = 't-meta';
  const who = document.createElement('strong');
  who.textContent = m.name;
  meta.append(who, `${m.location ? ` · ${m.location}` : ''} · ${clockTime(m.at)}`);
  const text = document.createElement('div');
  text.textContent = m.text;
  li.append(meta, text);
  items.push(li);
  return items;
}

async function fetchChat() {
  try {
    const res = await fetch(`/api/chat?after=${lastChatId}`, { cache: 'no-store' });
    const { messages } = await res.json();
    if (!messages.length) return;
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    for (const m of messages) log.append(...chatLine(m));
    lastChatId = messages[messages.length - 1].id;
    while (log.children.length > 300) log.firstElementChild.remove();
    $('chat-empty').hidden = true;
    if (atBottom || messages.some((m) => m.mine)) log.scrollTop = log.scrollHeight;
  } catch {
    // Try again on the next poll.
  }
}

async function onChatSubmit(e) {
  e.preventDefault();
  const text = $('c-text').value.trim();
  if (!text) return;
  const name = $('c-name').value;
  const location = $('c-location').value;
  rememberMe(name, location);
  $('chat-msg').textContent = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, name, location }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    $('c-text').value = '';
    fetchChat();
  } catch (err) {
    $('chat-msg').textContent = err.message;
  }
}

function tickProgress() {
  const np = state && state.nowPlaying;
  if (!np) return;
  const e = Math.min(elapsedSec(), np.duration);
  $('np-elapsed').textContent = fmt(e);
  $('np-bar').style.width = `${(e / np.duration) * 100}%`;
}

// ---- Main player -----------------------------------------------------------

function syncPlayer() {
  clearTimeout(endTimer);
  const np = state && state.nowPlaying;
  if (np) {
    const remaining = np.duration - elapsedSec();
    endTimer = setTimeout(fetchState, Math.max(0, remaining * 1000) + 750);
  }
  if (!playerReady || !tunedIn) return;
  if (!np) {
    player.stopVideo();
    loadedKey = null;
    return;
  }
  const key = `${np.id}@${np.startedAt}`;
  if (key !== loadedKey) {
    loadedKey = key;
    $('player-msg').hidden = true;
    player.loadVideoById({ videoId: np.videoId, startSeconds: Math.max(0, elapsedSec()) });
    // Browsers may block sound until the listener clicks once. If it hasn't started
    // after a few seconds, show the Tune in button.
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      if (!audible) {
        needsClick = true;
        render();
      }
    }, 4000);
    return;
  }
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    const drift = Math.abs(player.getCurrentTime() - elapsedSec());
    if (drift > DRIFT_TOLERANCE_SEC) player.seekTo(elapsedSec(), true);
  }
}

function onPlayerState(e) {
  const S = YT.PlayerState;
  const wasAudible = audible;
  // Some browsers start the video muted instead of blocking it; that still needs a click.
  audible =
    (e.data === S.PLAYING || e.data === S.BUFFERING) && (!player.isMuted() || mutedForPreview);
  if (audible) needsClick = false;
  if (audible !== wasAudible && state) render();
  // If a listener paused and resumes, jump back to where the station actually is.
  if (e.data === S.PLAYING) {
    const drift = Math.abs(player.getCurrentTime() - elapsedSec());
    if (drift > DRIFT_TOLERANCE_SEC) player.seekTo(elapsedSec(), true);
  }
  if (e.data === S.ENDED) playNextNow();
}

// The player can finish a second or two before the server moves on. Don't jump back
// to the old song in that gap; keep what we already switched to.
let skippedKey = null;

function keepLocalHandoff(data) {
  const np = data.nowPlaying;
  if (!skippedKey || !np || `${np.id}@${np.startedAt}` !== skippedKey) {
    skippedKey = null;
    return;
  }
  const leftMs = np.startedAt + np.duration * 1000 - data.serverTime;
  if (leftMs > 10_000) {
    skippedKey = null; // well off; trust the server
    return;
  }
  data.nowPlaying = state.nowPlaying;
  data.next = null;
}

// Start the next song the moment this one ends. This comes from the player itself, so it
// works even in a background tab, where the browser slows down the page's own timers.
function playNextNow() {
  const nx = state && state.next;
  if (nx) {
    const np = state.nowPlaying;
    skippedKey = np ? `${np.id}@${np.startedAt}` : null;
    if (state.nowPlaying) state.recent = [state.nowPlaying, ...state.recent].slice(0, 10);
    state.nowPlaying = { ...nx, startedAt: nx.startsAt };
    if (!nx.replay) {
      state.upNext = state.upNext.filter((t) => t.id !== nx.id);
      state.queueLength = Math.max(0, state.queueLength - 1);
    }
    state.next = null;
    render();
    syncPlayer();
  }
  fetchState();
}

function onPlayerError() {
  const np = state && state.nowPlaying;
  if (!np) return;
  const msg = $('player-msg');
  msg.textContent = `This one can't play here. Next song in ${fmt(np.duration - elapsedSec())}.`;
  msg.hidden = false;
}

function tuneIn() {
  tunedIn = true;
  needsClick = false;
  remember('tunedIn', '1');
  $('tune-in').hidden = true;
  const np = state && state.nowPlaying;
  if (playerReady && np && loadedKey === `${np.id}@${np.startedAt}`) {
    // Already loaded but held back by the browser: this click lets it play.
    player.unMute();
    player.seekTo(Math.max(0, elapsedSec()), true);
    player.playVideo();
  } else {
    syncPlayer();
  }
}

// ---- Add a song --------------------------------------------------------------

let preview = null;
let previewReady = false;
let pending = null; // { videoId, duration, title } once the preview has loaded
let probing = false;

function setPreviewStatus(text) {
  $('preview-status').textContent = text;
}

// ---- The questions ---------------------------------------------------------------

let shownQuestions = null;

function answerFields() {
  return [...document.querySelectorAll('#f-questions textarea')];
}

// Count the way the server does: runs of spaces and line breaks count as one character.
function answerLength(field) {
  return field.value.replace(/\s+/g, ' ').trim().length;
}

function updateAnswerCount(field) {
  const n = answerLength(field);
  const need = MIN_ANSWER - n;
  field.nextElementSibling.textContent =
    need > 0 ? `${need} more characters to go` : `${n}/${MAX_ANSWER}`;
}

function renderQuestions(info) {
  if (!info) return;
  const same = shownQuestions && shownQuestions.join('\n') === info.questions.join('\n');
  const period = info.rotation === 'month' ? 'month' : 'week';
  $('q-heading').textContent = info.paused ? 'Three questions' : `This ${period}'s questions`;
  if (same) return;
  // Keep whatever someone already typed if the questions change under them.
  const typed = answerFields().map((f) => f.value);
  shownQuestions = info.questions;
  $('f-questions').replaceChildren(
    ...info.questions.map((q, i) => {
      const label = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = `${i + 1}. ${q}`;
      const area = document.createElement('textarea');
      area.rows = 2;
      area.maxLength = MAX_ANSWER;
      area.required = true;
      area.value = typed[i] || '';
      const count = document.createElement('span');
      count.className = 'hint';
      area.addEventListener('input', () => {
        updateAnswerCount(area);
        updateSubmit();
      });
      label.append(text, area, count);
      updateAnswerCount(area);
      return label;
    })
  );
  updateSubmit();
}

// ---- Language ------------------------------------------------------------------

let langsShown = false;

function renderLanguages() {
  if (langsShown || !state.languages) return;
  langsShown = true;
  $('f-langs').replaceChildren(
    ...state.languages.map((l) => {
      const label = document.createElement('label');
      label.className = 'lang-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'language';
      input.value = l.id;
      input.required = true;
      input.addEventListener('change', updateSubmit);
      label.append(input, ` ${l.label}`);
      return label;
    })
  );
}

function chosenLanguage() {
  const checked = document.querySelector('input[name="language"]:checked');
  return checked ? checked.value : null;
}

function updateSubmit() {
  $('f-submit').disabled = !(
    pending &&
    chosenLanguage() &&
    answerFields().length > 0 &&
    answerFields().every((f) => answerLength(f) >= MIN_ANSWER) &&
    $('f-location').value.trim()
  );
}

// Tell people straight away if the song is already on the station: it won't be queued
// again, but their answers will be added to it.
let lookupFor = null;

async function checkAlready(id) {
  lookupFor = id;
  showAlready(null);
  if (!id) return;
  try {
    const res = await fetch(`/api/lookup?v=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const info = await res.json();
    if (lookupFor === id) showAlready(info.exists ? info : null);
  } catch {
    // If the check fails, the server still handles it when they submit.
  }
}

function showAlready(info) {
  $('already').hidden = !info;
  $('f-submit').textContent = info ? 'Add my answers' : 'Add to the queue';
  if (!info) return;
  const people = info.picks === 1 ? '1 person has' : `${info.picks} people have`;
  const when = info.onAir
    ? "It's playing right now."
    : info.position
      ? `It's number ${info.position} in the queue.`
      : "It already played and comes round again when the station replays past picks.";
  $('already').textContent =
    `“${info.title}” is already on the station (${people} picked it). ${when} ` +
    "It won't be added to the queue again, but you can still answer the questions and your answers will be shown with it.";
}

function onUrlInput() {
  const id = parseYouTubeId($('f-url').value);
  pending = null;
  updateSubmit();
  checkAlready(id);
  if (!id) {
    $('preview-wrap').hidden = true;
    setPreviewStatus($('f-url').value.trim() ? "That doesn't look like a YouTube link." : '');
    return;
  }
  if (!previewReady) {
    setPreviewStatus('Loading the YouTube player…');
    return;
  }
  $('preview-wrap').hidden = false;
  setPreviewStatus('Checking the video…');
  // Briefly play it muted so YouTube tells us its length and title, then stop.
  probing = true;
  preview.mute();
  preview.loadVideoById(id);
}

function onPreviewState(e) {
  if (probing && e.data === YT.PlayerState.PLAYING) {
    const duration = preview.getDuration();
    const data = preview.getVideoData();
    if (!duration) return;
    probing = false;
    preview.pauseVideo();
    preview.seekTo(0, true);
    preview.unMute();
    pending = { videoId: data.video_id, duration, title: data.title };
    setPreviewStatus(`✓ ${data.title} (${fmt(duration)})`);
    updateSubmit();
    return;
  }
  // Mute the station while someone listens to their preview.
  if (!probing && playerReady) {
    if (e.data === YT.PlayerState.PLAYING) {
      mutedForPreview = true;
      player.mute();
    } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) {
      mutedForPreview = false;
      player.unMute();
    }
  }
}

function onPreviewError() {
  probing = false;
  pending = null;
  updateSubmit();
  setPreviewStatus("That video can't be played on other sites. Try a different upload.");
}

async function onSubmit(e) {
  e.preventDefault();
  if (!pending) return;
  const msg = $('form-msg');
  $('f-submit').disabled = true;
  try {
    const res = await fetch('/api/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...pending,
        questions: shownQuestions,
        answers: answerFields().map((f) => f.value),
        name: $('f-name').value,
        location: $('f-location').value,
        language: chosenLanguage(),
      }),
    });
    rememberMe($('f-name').value, $('f-location').value);
    const body = await res.json();
    if (res.status === 409 && body.questions) renderQuestions(body.questions);
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    msg.className = 'form-msg ok';
    const where = body.position ? `It's number ${body.position} in the queue.` : "It's on the air right now.";
    msg.textContent = body.joined
      ? 'Thanks! Your answers were added to the song.'
      : `Added! ${where}`;
    $('f-url').value = '';
    showAlready(null);
    for (const f of answerFields()) {
      f.value = '';
      updateAnswerCount(f);
    }
    for (const r of document.querySelectorAll('input[name="language"]')) r.checked = false;
    $('preview-wrap').hidden = true;
    if (preview) preview.stopVideo();
    mutedForPreview = false;
    if (playerReady) player.unMute();
    setPreviewStatus('');
    pending = null;
    fetchState();
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = err.message;
  } finally {
    updateSubmit();
  }
}

// ---- Startup -------------------------------------------------------------------

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    playerVars: { controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        syncPlayer();
      },
      onStateChange: onPlayerState,
      onError: onPlayerError,
    },
  });
  preview = new YT.Player('preview', {
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        previewReady = true;
        if ($('f-url').value) onUrlInput();
      },
      onStateChange: onPreviewState,
      onError: onPreviewError,
    },
  });
};

let urlTimer = null;
$('f-url').addEventListener('input', () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(onUrlInput, 400);
});
$('f-location').addEventListener('input', updateSubmit);
$('add-form').addEventListener('submit', onSubmit);
$('tune-in').addEventListener('click', tuneIn);
$('chat-form').addEventListener('submit', onChatSubmit);
$('note-form').addEventListener('submit', onNoteSubmit);
$('note-cancel').addEventListener('click', () => $('note-dialog').close());

for (const [nameId, locId] of [['f-name', 'f-location'], ['c-name', 'c-location']]) {
  $(nameId).value = me().name;
  $(locId).value = me().location;
}

fetchState();
fetchChat();
setInterval(fetchChat, CHAT_POLL_MS);
setInterval(fetchState, POLL_MS);
setInterval(tickProgress, 500);
