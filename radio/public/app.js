'use strict';

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const DRIFT_TOLERANCE_SEC = 3;

let state = null;
let clockOffset = 0; // serverTime - local time
let player = null;
let playerReady = false;
let tunedIn = false;
let loadedTrackId = null;
let endTimer = null;

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
    const res = await fetch('/api/state', { cache: 'no-store' });
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

function trackItem(t) {
  const li = document.createElement('li');
  const title = document.createElement('div');
  title.className = 't-title';
  title.textContent = t.title;
  const meta = document.createElement('div');
  meta.className = 't-meta';
  meta.textContent = `${fmt(t.duration)} · picked by ${t.name}`;
  const blurb = document.createElement('div');
  blurb.className = 't-blurb';
  blurb.textContent = `“${t.blurb}”`;
  li.append(title, meta, blurb);
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
    $('np-blurb').textContent = np.blurb;
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
    `Now playing ${track.title}, picked by ${track.name}. ${track.blurb}`
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

function updateSubmit() {
  $('f-submit').disabled = !(pending && $('f-blurb').value.trim());
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
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    msg.className = 'form-msg ok';
    msg.textContent = body.position
      ? `Added! It's number ${body.position} in the queue.`
      : "Added! It's on the air right now.";
    $('f-url').value = '';
    $('f-blurb').value = '';
    $('blurb-count').textContent = '0';
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
  $('blurb-count').textContent = $('f-blurb').value.length;
  updateSubmit();
});
$('add-form').addEventListener('submit', onSubmit);
$('tune-in').addEventListener('click', tuneIn);

fetchState();
setInterval(fetchState, POLL_MS);
setInterval(tickProgress, 500);
