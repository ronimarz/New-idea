# Open Air Radio

A single global radio station that anyone can add to, meant to be left on in the background all day, like the Lofi Girl stream on YouTube. You paste a YouTube link, say where you're listening from, and answer three questions about the song. Your song joins the queue, and when it plays, everyone listening sees your answers and location next to it.

- **Everyone hears the same thing.** The server keeps one schedule, and every listener's player jumps to the same spot in the current song.
- **Made to leave on.** The player and the current pick sit up top with the chat beside them, and everything else is below. "Just listen" hides everything but the music and the chat. When a song ends, the next one starts right away, even in a background tab. Returning listeners start playing without clicking, if their browser allows it. The tab title shows what's playing.
- **English songs and instrumentals, for now.** People say whether a song's lyrics are in English or it's instrumental; anything else is turned away. A title written mostly in another script (Korean, Cyrillic…) gets a warning badge on the admin page so you can check it.
- **It never goes quiet.** New picks play in the order they were added. When the queue is empty, the station replays past picks at random, skipping anything that played recently.
- **Three questions make people think.** Everyone who adds a song answers three questions, such as "Why this song?", "What does it mean to you?" and "When did you first hear it?" Each answer needs at least 40 characters. The questions change on their own every week (or month), cycling through 8 built-in sets, and you can write your own on the admin page at any time. Each pick keeps the questions it was answered with.
- **The answers are the DJ.** They show under the player. Listeners can turn on "Read each pick's story aloud," which uses the browser's text-to-speech and turns the music down while it talks.
- **Hearts, and nothing negative.** Listeners can heart a pick they love, once per song, and take it back. There are no downvotes, rankings or "top songs" lists. On your own pick you see "Your pick" and how many people love it, and who gave the hearts stays private. Hearted songs come back a little more often when the station replays past picks, up to 3 times as often.
- **Listening together.** A live chat sits beside the station, and it marks which song was playing when people were talking. A line at the top shows how many people are listening and where from.
- **Thank-you notes.** Under any pick, "Say thanks" sends the person who chose it a private note. They see it the next time they visit, and nobody else ever can. They can clear notes they don't want to keep.
- **Any genre, any YouTube video** that allows embedding, up to 15 minutes long.

Playback uses YouTube's embedded player, so YouTube handles the music rights. The station never stores or streams audio itself.

## Run it

You need Node.js 18 or newer. There are no packages to install.

```bash
cd radio
npm start          # http://localhost:3000
npm test
```

Settings, all optional:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `DATA_FILE` | `radio/data/station.json` | Where the station's songs and schedule are saved. |
| `ADMIN_TOKEN` | random | The admin password. If it isn't set, a new one is made at each start and printed in the terminal. |
| `STATION_LANGUAGES` | `english,instrumental` | Which songs are accepted. Use `english` alone to turn instrumentals away. |
| `QUESTION_ROTATION` | `week` | How often the questions change: `week` (Mondays, UTC) or `month` (the 1st). |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so the per-person limits use the real visitor IP. |

## The admin page

Go to `/admin` and sign in with the admin password. From there you can:

- see the current questions and when the next set starts, write your own three (they stay until you change them), or go back to the rotation
- see every song with its blurb, status (on air, queued, played), plays and hearts, and search them
- remove a song (if it's on air, the next one starts right away)
- skip the current song
- delete chat messages
- ban a person, which removes all their songs, chat messages and notes and stops them posting again. Bans can be undone, but the removed posts can't come back.

Private thank-you notes aren't shown on the admin page. Their recipient can clear them, and banning the sender removes all their notes.

## How adding a song works

1. When you paste a link, the page loads it in a small preview player. That's how it learns the song's title and length, and finds out early whether the video can play on other sites.
2. You say whether the lyrics are in English or it's instrumental. People can pick the wrong option, so the admin page flags titles that look like they're in another language.
3. You answer the current three questions, 40 to 240 characters each, and say where you're listening from. Adding your name is optional. The minimum is there to make people say something real, not just "great song!". Each answer has a counter showing how many more characters are needed, and the button stays disabled until all three have enough. Extra spaces and line breaks don't count. If the questions change while someone is filling in the form, their answers are kept and they're shown the new questions.
4. The server checks the submission and adds it to the end of the queue. If nothing is playing, it goes on air right away.

## Abuse limits

These are basic, for a first version:

- Each visitor (identified by a hash of their IP address) can submit once every 30 seconds and have at most 3 songs waiting.
- The same video can't be in the queue twice at once.
- Names, locations and blurbs are length-limited, and they're always shown as plain text, never as HTML.

- Chat allows one message every 2 seconds, and notes one every 10 seconds, with one note per song per person.

People are identified by their internet address, since there are no accounts yet. People sharing Wi-Fi look like one person, and a determined troll can come back from a different network after a ban.

## Files

- `station.js`: the station's rules (queue, rotation, timing, validation). It has no web or file code, so it's easy to test.
- `questions.js`: the question sets and the weekly or monthly rotation.
- `community.js`: chat, thank-you notes and who's listening. Like `station.js`, it has no web or file code.
- `server.js`: a small HTTP server. It serves the pages and the JSON API, checks the admin password and saves everything to `DATA_FILE`.
- `public/`: the station page (`index.html`, `app.js`) and the admin page (`admin.html`, `admin.js`).
- `test/`: tests for `station.js`, `questions.js` and `community.js`.
