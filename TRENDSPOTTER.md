# trendspotter: catch songs before they blow up

`trendspotter` checks the music charts every day and lists the songs that are **climbing fast**, not the ones already at #1 that everyone knows. It's built for making CapCut templates: if your template for a song is out before the song takes off, yours is the one people find and use.

Each run gives you:

- **A ranked list of rising songs.** Higher scores mean the song is climbing harder.
- **A report you can open on your phone,** with links to search each song on TikTok, Spotify and YouTube.
- **A "NEW" tag** on songs that weren't in your last report.
- **An optional email** of the report, so you don't have to open anything.

## How it decides what's "rising"

It saves a snapshot of the charts each run and compares it with the charts from a few days earlier. A song scores points for:

- **Climbing:** jumping 30 places on a 100-song chart scores 30.
- **Being new on a chart.**
- **Rising on more than one chart at once:** +15 for each extra chart. This is the strongest sign.

It scores **half** for songs that are already top-10 hits or have been charting for 2+ months, since by then the templates already exist.

**The first day is the weakest.** Spotify's chart says what moved since yesterday, so you get some results right away. But the comparisons get much better after **3–4 days of runs**, so set it to run every day (see below).

## Charts it watches

| Chart | Setup | What it tells you |
|---|---|---|
| Apple Music Top 100 | none | What's being played most on Apple Music |
| Spotify daily chart (via [kworb.net](https://kworb.net)) | none | Spotify's top songs, with daily movement |
| Last.fm | free key | What people are listening to right now |

To add Last.fm, get a free key at [last.fm/api/account/create](https://www.last.fm/api/account/create). You can put anything for the "callback URL". Paste the key into `api_key` in your config.

## Setup (one time, about 10 minutes)

1. **Install Python 3.11 or newer** from [python.org/downloads](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"** in the installer.
2. **Download this project:** on GitHub, switch to the `trendspotter` branch, click **Code → Download ZIP**, and unzip it.
3. **Open a terminal in that folder.**
   - Windows: open the folder, click the address bar, type `cmd`, and press Enter.
   - Mac: right-click the folder and choose **New Terminal at Folder**.
4. **Make your config:**
   - Windows: `copy trendspotter.example.toml trendspotter.toml`
   - Mac: `cp trendspotter.example.toml trendspotter.toml`
5. **Run it:** `python -m trendspotter` (on Mac, `python3 -m trendspotter`).

The report is saved in the `trends` folder. Open the `.html` file in your browser.

### Get it by email (optional)

In `trendspotter.toml`, fill in the `[email]` section. For Gmail:

1. Turn on 2-Step Verification for your Google account.
2. Create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Paste that 16-letter password into `password`. Never use your normal password here.

### Run it every day automatically

- **Mac:** run `crontab -e` and add `0 9 * * * cd /path/to/folder && python3 -m trendspotter`. That runs it every morning at 9.
- **Windows:** open Task Scheduler, choose **Create Basic Task → Daily**, set the program to `python`, the arguments to `-m trendspotter`, and **Start in** to the project folder.

Your computer needs to be on at that time. If it isn't, just run it whenever you sit down.

## Turning it into templates

1. **Check the report** (or your email) each morning.
2. **Pick 1–2 songs** with high scores, especially ones tagged **NEW** or **rising on 2+ charts**.
3. **Tap the TikTok link.** If the song has few videos or templates yet, that's your window.
4. **Make the template in CapCut** that day, timed to the part of the song people would use (usually the hook or the beat drop).
5. **Watch what works.** After a few weeks, you'll see which kinds of songs and edits get the most uses. Do more of those.

## Settings worth knowing

- `lookback_days`: how far back to compare. 3 catches songs early; 7 is steadier but later.
- `min_score`: lower it to see more songs, raise it to see only the strongest risers.
- `country`: watch a different country's charts, e.g. `"gb"` or `"global"` for Spotify.
- `--no-email`: skips the email for one run.

## Troubleshooting

- **"[spotify] failed" or "[apple] failed":** that chart was unreachable or changed its layout. The others still work. If it keeps failing, it's likely a layout change and the code needs a small fix.
- **Nothing rising:** normal for the first run or two. It needs a few days of history.
- **Email didn't send:** check that you used an app password, not your normal Gmail password.

## Tests

```bash
python -m unittest
```
