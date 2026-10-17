'use strict';

// A first line of defense for everything people write: chat, answers, notes, names and
// places. It blocks links and words on the station's blocked list. The admin edits the
// list; this is only the starting point. It catches the obvious, not everything.

// Severe slurs only. Everyday swearing is left alone unless the admin adds it.
const STARTER_WORDS = [
  'chink',
  'coon',
  'dyke',
  'fag',
  'faggot',
  'gook',
  'kike',
  'nigga',
  'nigger',
  'paki',
  'raghead',
  'retard',
  'spic',
  'tranny',
  'wetback',
];

const MAX_WORDS = 1000;

// Undo common disguises: n1gg3r, f@g, $pic.
const LOOKALIKES = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function normalize(word) {
  return word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[013457@$]/g, (c) => LOOKALIKES[c])
    .replace(/[^a-z]/g, '');
}

// Anything that looks like a web address: http://, www., name.com, or name (dot) com.
const LINK =
  /(https?:\/\/|www\.|\b[a-z0-9-]+(\.|\s*[([]dot[)\]]\s*)(com|net|org|io|co|me|ly|gg|tv|xyz|info|biz|app|link|site|online|shop|ru|cn|uk|de)\b)/i;

class Moderation {
  constructor(data = {}) {
    this.words = data.words || [...STARTER_WORDS];
  }

  toJSON() {
    return { words: this.words };
  }

  setWords(input) {
    const words = [...new Set(String(input || '').split(/[\n,]+/).map(normalize).filter(Boolean))];
    if (words.length > MAX_WORDS) return { error: `The list can hold up to ${MAX_WORDS} words.` };
    this.words = words.sort();
    return { words: this.words };
  }

  // Returns an error message for the first problem found in any of the texts, or null.
  check(...texts) {
    const blocked = new Set(this.words);
    for (const text of texts.flat()) {
      if (typeof text !== 'string' || !text) continue;
      if (LINK.test(text)) return "Links aren't allowed here.";
      // Whole words only, so "Scunthorpe" or "class" never trip the filter. Plurals count.
      for (const raw of text.split(/[\s.,;:?"'()[\]{}<>/\\|*_~^-]+/)) {
        const w = normalize(raw);
        if (w && (blocked.has(w) || (w.endsWith('s') && blocked.has(w.slice(0, -1))))) {
          return 'Please keep it kind. That has a word that isn’t allowed here.';
        }
      }
    }
    return null;
  }
}

module.exports = { Moderation, STARTER_WORDS };
