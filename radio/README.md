# Open Air Radio

A single global radio station that anyone can add to. You paste a YouTube link, say where you're listening from, and write a few sentences on why people should hear it. Your song joins the queue, and when it plays, everyone listening sees your blurb and location next to it.

- **Everyone hears the same thing.** The server keeps one schedule, and every listener's player jumps to the same spot in the current song.
- **It never goes quiet.** New picks play in the order they were added. When the queue is empty, the station replays past picks at random, skipping anything that played recently.
- **The blurb is the DJ.** It shows under the player. Listeners can turn on "Read the blurbs aloud," which uses the browser's text-to-speech and turns the music down while it talks.
- **Hearts, and nothing negative.** Listeners can heart a pick they love, once per song, and take it back. There are no downvotes, rankings or "top songs" lists. On your own pick you see "Your pick" and how many people love it, and who gave the hearts stays private. Hearted songs come back a little more often when the station replays past picks, up to 3 times as often.
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
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so the per-person limits use the real visitor IP. |

## How adding a song works

1. When you paste a link, the page loads it in a small preview player. That's how it learns the song's title and length, and finds out early whether the video can play on other sites.
2. You write a blurb of 100 to 280 characters and say where you're listening from. Adding your name is optional. The minimum is there to make people say something real, not just "great song!". The counter shows how many more characters are needed, and the button stays disabled until there are enough. Extra spaces and line breaks don't count toward it.
3. The server checks the submission and adds it to the end of the queue. If nothing is playing, it goes on air right away.

## Abuse limits

These are basic, for a first version:

- Each visitor (identified by a hash of their IP address) can submit once every 30 seconds and have at most 3 songs waiting.
- The same video can't be in the queue twice at once.
- Names, locations and blurbs are length-limited, and they're always shown as plain text, never as HTML.

There's no moderation queue or way to remove a song yet. Before you open it up publicly, you'll want at least an admin "remove" button, and maybe reporting or upvotes.

## Files

- `station.js`: the station's rules (queue, rotation, timing, validation). It has no web or file code, so it's easy to test.
- `server.js`: a small HTTP server. It serves the page, has `GET /api/state`, `POST /api/tracks` and `PUT`/`DELETE /api/tracks/:id/heart`, and saves to `DATA_FILE`.
- `public/`: the web page.
- `test/`: tests for `station.js`.
