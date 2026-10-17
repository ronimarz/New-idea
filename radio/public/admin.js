'use strict';

const $ = (id) => document.getElementById(id);
let data = null;

function token() {
  try {
    return sessionStorage.getItem('adminToken') || '';
  } catch {
    return window.adminToken || '';
  }
}

function setToken(value) {
  try {
    if (value) sessionStorage.setItem('adminToken', value);
    else sessionStorage.removeItem('adminToken');
  } catch {
    window.adminToken = value;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (res.status === 401) {
    setToken('');
    showLogin(json.error);
    throw new Error(json.error);
  }
  if (!res.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

function showLogin(message = '') {
  $('login').hidden = false;
  $('panel').hidden = true;
  $('login-msg').textContent = message;
}

function when(ms) {
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, onClick, className = 'secondary') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function ban(author, name) {
  if (!confirm(`Ban ${name} (${author.slice(0, 6)}) and remove everything they've posted?`)) return;
  const { removed } = await api('POST', '/api/admin/ban', { author });
  alert(`Removed ${removed.songs} songs, ${removed.messages} chat messages and ${removed.notes} notes.`);
  load();
}

function render() {
  $('summary').textContent =
    `${data.tracks.length} songs · ${data.listeners} listening now · ${data.banned.length} banned`;

  const q = $('filter').value.trim().toLowerCase();
  const tracks = data.tracks.filter(
    (t) => !q || [t.title, t.name, t.location, t.blurb].join(' ').toLowerCase().includes(q)
  );
  $('tracks').replaceChildren(
    ...tracks.map((t) => {
      const li = el('li');
      const title = el('div', 't-title');
      const link = el('a', null, t.title);
      link.href = `https://www.youtube.com/watch?v=${t.videoId}`;
      link.target = '_blank';
      link.rel = 'noopener';
      title.append(link, el('span', 'status', t.status));
      li.append(
        title,
        el('div', 't-meta',
          `${t.name}${t.location ? ` in ${t.location}` : ''} · ${when(t.addedAt)} · ` +
          `played ${t.plays}× · ♥ ${t.hearts} · person ${t.author.slice(0, 6)}`),
        el('div', 't-blurb', `“${t.blurb}”`),
        el('div', 'actions'),
      );
      li.lastChild.append(
        button('Remove song', async () => {
          if (!confirm(`Remove “${t.title}”? This can't be undone.`)) return;
          await api('DELETE', `/api/admin/tracks/${t.id}`);
          load();
        }),
        button('Ban person', () => ban(t.author, t.name), 'danger'),
      );
      return li;
    })
  );

  $('chat').replaceChildren(
    ...data.chat.map((m) => {
      const li = el('li');
      li.append(
        el('div', 't-meta',
          `${m.name}${m.location ? ` · ${m.location}` : ''} · ${when(m.at)} · person ${m.author.slice(0, 6)}`),
        el('div', null, m.text),
        el('div', 'actions'),
      );
      li.lastChild.append(
        button('Delete message', async () => {
          await api('DELETE', `/api/admin/chat/${m.id}`);
          load();
        }),
        button('Ban person', () => ban(m.author, m.name), 'danger'),
      );
      return li;
    })
  );
  $('chat-empty').hidden = data.chat.length > 0;

  $('banned').replaceChildren(
    ...data.banned.map((key) => {
      const li = el('li', 'admin-row');
      li.append(
        el('span', null, `Person ${key.slice(0, 6)}`),
        button('Unban', async () => {
          await api('DELETE', `/api/admin/ban/${key}`);
          load();
        }),
      );
      return li;
    })
  );
  $('banned-empty').hidden = data.banned.length > 0;
}

async function load() {
  try {
    data = await api('GET', '/api/admin/overview');
    $('login').hidden = true;
    $('panel').hidden = false;
    render();
  } catch (err) {
    if (token()) alert(err.message);
  }
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  setToken($('token').value.trim());
  load();
});
$('logout').addEventListener('click', () => {
  setToken('');
  showLogin();
});
$('skip').addEventListener('click', async () => {
  await api('POST', '/api/admin/skip');
  load();
});
$('filter').addEventListener('input', () => data && render());

if (token()) load();
else showLogin();
setInterval(() => {
  // Keep the lists fresh, but not while the admin is typing a search.
  if (token() && !$('panel').hidden && document.activeElement !== $('filter')) load();
}, 15000);
