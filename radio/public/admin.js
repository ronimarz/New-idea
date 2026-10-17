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
  alert(`Removed ${removed.songs} picks, ${removed.messages} chat messages and ${removed.notes} notes.`);
  load();
}

function answersEl(answers) {
  const dl = el('dl', 'answers small');
  for (const { question, answer } of answers) dl.append(el('dt', null, question), el('dd', null, answer));
  return dl;
}

// ---- Question sets ---------------------------------------------------------------

let editingSet = null; // id of the set being edited, if any

function questionInputs(values, prefix) {
  return values.map((v, i) => {
    const input = el('input');
    input.maxLength = 140;
    input.required = true;
    input.value = v;
    input.setAttribute('aria-label', `${prefix} ${i + 1}`);
    return input;
  });
}

async function setAction(method, path, body) {
  try {
    await api(method, path, body);
    $('q-msg').textContent = '';
    await load();
  } catch (err) {
    $('q-msg').textContent = err.message;
  }
}

function renderQuestions() {
  const q = data.questions;
  const period = q.rotation === 'month' ? 'month' : 'week';
  $('q-status').textContent = q.paused
    ? `Showing set ${q.set} of ${q.sets}. The rotation is paused, so it stays until you change it.`
    : `Showing set ${q.set} of ${q.sets}. The next set in the list starts ${when(q.changesAt)}, ` +
      `then one each ${period}, looping back to the top.`;
  $('q-paused').checked = q.paused;

  $('q-sets').replaceChildren(
    ...q.list.map((set, i) => {
      const li = el('li', set.id === q.setId ? 'q-set showing' : 'q-set');
      const head = el('div', 'q-set-head');
      head.append(el('strong', null, `Set ${i + 1}`));
      if (set.id === q.setId) head.append(el('span', 'status', 'showing now'));
      li.append(head);

      if (editingSet === set.id) {
        const form = el('form', 'q-form');
        const inputs = questionInputs(set.questions, `Set ${i + 1}, question`);
        const buttons = el('div', 'actions');
        const saveBtn = el('button', null, 'Save');
        saveBtn.type = 'submit';
        buttons.append(saveBtn, button('Cancel', () => {
          editingSet = null;
          render();
        }));
        form.append(...inputs, buttons);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          editingSet = null;
          await setAction('PUT', `/api/admin/question-sets/${set.id}`, { questions: inputs.map((x) => x.value) });
        });
        li.append(form);
        return li;
      }

      const ol = el('ol', 'q-list-items');
      ol.append(...set.questions.map((text) => el('li', null, text)));
      const buttons = el('div', 'actions');
      buttons.append(
        button('↑', () => setAction('POST', `/api/admin/question-sets/${set.id}/move`, { by: -1 })),
        button('↓', () => setAction('POST', `/api/admin/question-sets/${set.id}/move`, { by: 1 })),
        button('Edit', () => {
          editingSet = set.id;
          render();
        }),
      );
      buttons.children[0].disabled = i === 0;
      buttons.children[0].setAttribute('aria-label', `Move set ${i + 1} up`);
      buttons.children[1].disabled = i === q.list.length - 1;
      buttons.children[1].setAttribute('aria-label', `Move set ${i + 1} down`);
      if (set.id !== q.setId) {
        buttons.append(button('Use this set now', () => setAction('POST', `/api/admin/question-sets/${set.id}/use`)));
      }
      if (q.list.length > 1) {
        buttons.append(button('Delete', () => {
          if (confirm(`Delete set ${i + 1}? Songs already answered with it keep their answers.`)) {
            setAction('DELETE', `/api/admin/question-sets/${set.id}`);
          }
        }, 'danger'));
      }
      li.append(ol, buttons);
      return li;
    })
  );
}

function render() {
  renderQuestions();
  $('summary').textContent =
    `${data.tracks.length} songs · ${data.listeners} listening now · ${data.banned.length} banned`;

  const q = $('filter').value.trim().toLowerCase();
  const tracks = data.tracks.filter(
    (t) =>
      !q ||
      [t.title, ...t.picks.flatMap((p) => [p.name, p.location, ...p.answers.map((a) => a.answer)])]
        .join(' ')
        .toLowerCase()
        .includes(q)
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
      if (t.language === 'instrumental') title.append(el('span', 'status', 'instrumental'));
      if (t.flag) title.append(el('span', 'status flag', `⚠ ${t.flag}`));
      const picks = t.picks.length === 1 ? '1 pick' : `${t.picks.length} picks`;
      const songActions = el('div', 'actions');
      songActions.append(
        button('Remove song', async () => {
          if (!confirm(`Remove “${t.title}” and all ${picks}? This can't be undone.`)) return;
          await api('DELETE', `/api/admin/tracks/${t.id}`);
          load();
        }),
      );
      li.append(title, el('div', 't-meta', `${picks} · played ${t.plays}× · ♥ ${t.hearts}`), songActions);

      // Each person's pick of this song, with their answers.
      const list = el('ol', 'admin-picks');
      for (const p of t.picks) {
        const item = el('li');
        const acts = el('div', 'actions');
        if (t.picks.length > 1) {
          acts.append(button('Remove this pick', async () => {
            if (!confirm(`Remove ${p.name}'s pick of “${t.title}”?`)) return;
            await api('DELETE', `/api/admin/tracks/${t.id}/picks/${p.id}`);
            load();
          }));
        }
        acts.append(button('Ban person', () => ban(p.author, p.name), 'danger'));
        item.append(
          el('div', 't-meta',
            `${p.name}${p.location ? ` in ${p.location}` : ''} · ${when(p.addedAt)} · person ${p.author.slice(0, 6)}`),
          answersEl(p.answers),
          acts,
        );
        list.append(item);
      }
      li.append(list);
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
$('q-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const questions = [1, 2, 3].map((i) => $(`qa${i}`).value);
  await setAction('POST', '/api/admin/question-sets', { questions });
  if (!$('q-msg').textContent) for (const i of [1, 2, 3]) $(`qa${i}`).value = '';
});
$('q-paused').addEventListener('change', () => setAction('PUT', '/api/admin/rotation', { paused: $('q-paused').checked }));

if (token()) load();
else showLogin();
setInterval(() => {
  // Keep the lists fresh, but not while the admin is typing a search...
  // ...or while they're editing or adding a question set.
  const busy =
    document.activeElement === $('filter') ||
    editingSet != null ||
    ($('q-section').contains(document.activeElement) && document.activeElement.tagName === 'INPUT');
  if (token() && !$('panel').hidden && !busy) load();
}, 15000);
