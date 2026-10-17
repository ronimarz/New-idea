'use strict';

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const CHAT_POLL_MS = 2500;
const DRIFT_TOLERANCE_SEC = 3;
const MIN_BLURB = 100;
const MAX_BLURB = 280;

let state = null;
let clockOffset = 0; // serverTime - local time
let player = null;
let playerReady = false;
let tunedIn = false;
let loadedTrackId = null;
let endTimer = null;

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

function pickedBy(t) {
  return t.location ? `${t.name} in ${t.location}` : t.name;
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

// A private thank-you to the person who picked the song.
function noteControl(t) {
  if (t.mine) return null;
  if (state.thanked.includes(t.id)) {
    const span = document.createElement('span');
    span.className = 'sent';
    span.textContent = '✉ Thanks sent';
    return span;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'heart';
  btn.textContent = '✉ Say thanks';
  btn.title = `Send ${t.name} a private note`;
  btn.addEventListener('click', () => openNote(t));
  return btn;
}

function actions(t) {
  const div = document.createElement('div');
  div.className = 'actions';
  div.append(...[heartControl(t), noteControl(t)].filter(Boolean));
  return div;
}

function trackItem(t) {
  const li = document.createElement('li');
  const title = document.createElement('div');
  title.className = 't-title';
  title.textContent = t.title;
  const meta = document.createElement('div');
  meta.className = 't-meta';
  meta.textContent = `${fmt(t.duration)} · picked by ${pickedBy(t)}`;
  const blurb = document.createElement('div');
  blurb.className = 't-blurb';
  blurb.textContent = `“${t.blurb}”`;
  li.append(title, meta, blurb, actions(t));
  return li;
}

function render() {
  const np = state.nowPlaying;
  $('np-empty').hidden = !!np;
  $('np-info').hidden = !np;
  $('tune-in').hidden = !np || tunedIn;
  if (np) {
    $('np-title').textContent = np.title;
    $('np-name').textContent = np.name;
    $('np-from').textContent = np.location ? ` in ${np.location}` : '';
    $('np-blurb').textContent = np.blurb;
    $('np-heart').replaceChildren(...actions(np).childNodes);
    $('np-total').textContent = fmt(np.duration);
    document.title = `${np.title} · Open Air Radio`;
  } else {
    document.title = 'Open Air Radio';
  }

  $('up-next').replaceChildren(...state.upNext.map(trackItem));
  $('next-empty').hidden = state.upNext.length > 0 || !np;
  $('queue-count').textContent = state.queueLength ? `(${state.queueLength})` : '';
  $('recent').replaceChildren(...state.recent.map(trackItem));
  $('recent-empty').hidden = state.recent.length > 0;
  renderListeners();
  renderInbox();
}

function renderListeners() {
  const { count, places, morePlaces } = state.listeners;
  let text = `${count} ${count === 1 ? 'person' : 'people'} listening`;
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

function openNote(t) {
  noteTrack = t;
  const who = me();
  $('note-heading').textContent = `Say thanks to ${t.name}`;
  $('note-song').textContent = `For picking “${t.title}”`;
  $('note-private').textContent = `Only ${t.name} will see this, the next time they visit.`;
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
      body: JSON.stringify({ text: $('n-text').value, name, location }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    state.thanked.push(noteTrack.id);
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
    loadedTrackId = null;
    return;
  }
  if (np.id !== loadedTrackId) {
    loadedTrackId = np.id;
    $('player-msg').hidden = true;
    announce(np);
    player.loadVideoById({ videoId: np.videoId, startSeconds: Math.max(0, elapsedSec()) });
    return;
  }
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    const drift = Math.abs(player.getCurrentTime() - elapsedSec());
    if (drift > DRIFT_TOLERANCE_SEC) player.seekTo(elapsedSec(), true);
  }
}

function onPlayerState(e) {
  // If a listener paused and resumes, jump back to where the station actually is.
  if (e.data === YT.PlayerState.PLAYING) {
    const drift = Math.abs(player.getCurrentTime() - elapsedSec());
    if (drift > DRIFT_TOLERANCE_SEC) player.seekTo(elapsedSec(), true);
  }
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
  $('tune-in').hidden = true;
  syncPlayer();
}

// ---- DJ voice ----------------------------------------------------------------

function announce(track) {
  if (!$('dj-voice').checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(
    `Now playing ${track.title}, picked by ${pickedBy(track)}. ${track.blurb}`
  );
  const restore = () => {
    if (playerReady) player.setVolume(100);
  };
  u.onstart = () => {
    if (playerReady) player.setVolume(20);
  };
  u.onend = restore;
  u.onerror = restore;
  speechSynthesis.speak(u);
}

// ---- Add a song --------------------------------------------------------------

let preview = null;
let previewReady = false;
let pending = null; // { videoId, duration, title } once the preview has loaded
let probing = false;

function setPreviewStatus(text) {
  $('preview-status').textContent = text;
}

// Count the way the server does: runs of spaces and line breaks count as one character.
function blurbLength() {
  return $('f-blurb').value.replace(/\s+/g, ' ').trim().length;
}

function updateBlurbCount() {
  const n = blurbLength();
  const need = MIN_BLURB - n;
  $('blurb-count').textContent =
    need > 0 ? `${need} more characters to go (at least ${MIN_BLURB})` : `${n}/${MAX_BLURB}`;
}

function updateSubmit() {
  $('f-submit').disabled = !(
    pending &&
    blurbLength() >= MIN_BLURB &&
    $('f-location').value.trim()
  );
}

function onUrlInput() {
  const id = parseYouTubeId($('f-url').value);
  pending = null;
  updateSubmit();
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
    if (e.data === YT.PlayerState.PLAYING) player.mute();
    else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) player.unMute();
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
        blurb: $('f-blurb').value,
        name: $('f-name').value,
        location: $('f-location').value,
      }),
    });
    rememberMe($('f-name').value, $('f-location').value);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    msg.className = 'form-msg ok';
    msg.textContent = body.position
      ? `Added! It's number ${body.position} in the queue.`
      : "Added! It's on the air right now.";
    $('f-url').value = '';
    $('f-blurb').value = '';
    updateBlurbCount();
    $('preview-wrap').hidden = true;
    if (preview) preview.stopVideo();
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
$('f-blurb').addEventListener('input', () => {
  updateBlurbCount();
  updateSubmit();
});
$('f-location').addEventListener('input', updateSubmit);
updateBlurbCount();
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
