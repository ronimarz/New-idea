# gapfinder: find what people want that nobody offers yet

`gapfinder` reads recent public posts on Reddit, Hacker News and Software Recommendations, and picks out the ones where someone wants something that doesn't exist (or isn't good enough), like:

- "Is there an app that..."
- "I'd pay for..."
- "Why is there no way to..."
- "X raised their prices, looking for alternatives"

Then it **groups posts asking for the same thing**, so you can see which needs come up again and again, in different places, from different people. Those repeated needs are business ideas with proof that people want them.

**No accounts, no API keys, no signups.** It uses the public RSS feeds and open search services that news-reader apps use.

## What you get

- **A ranked list of unmet needs.** Each one shows how many people asked, where, and their actual words, with links to the posts.
- **Signal tags** showing how strong the demand is:

  | Tag | Meaning | Strength |
  |---|---|---|
  | **would pay** | someone said they'd pay for it | strongest |
  | **nothing exists** | "why is there no...", "someone should make..." | strong |
  | **looking for a tool** | "is there an app that..." | medium |
  | **switching away** | a product shut down or raised prices | medium |
  | **asking for software** | posted where every post is a request | medium |
  | **frustrated** | "so frustrating", "drives me crazy" | weak |

- **NEW tags** on needs with posts you haven't seen before.
- **Filters** in the report: "asked 2+ times", "new only", and a search box.
- **An optional email** of the report.

## Setup (one time, about 5 minutes)

1. **Install Python 3.11 or newer** from [python.org/downloads](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"** in the installer.
2. **Download this project:** on GitHub, switch to the `gapfinder` branch, click **Code → Download ZIP**, and unzip it.
3. **Open a terminal in that folder.**
   - Windows: open the folder, click the address bar, type `cmd`, and press Enter.
   - Mac: right-click the folder and choose **New Terminal at Folder**.
4. **Make your config:**
   - Windows: `copy gapfinder.example.toml gapfinder.toml`
   - Mac: `cp gapfinder.example.toml gapfinder.toml`
5. **Run it:** `python -m gapfinder` (on Mac, `python3 -m gapfinder`). It takes about a minute, because it waits a couple of seconds between Reddit requests so Reddit doesn't block it.

The report is saved in the `gaps` folder. Open the `.html` file in your browser.

## Pointing it at what you care about

In `gapfinder.toml`:

- **`subreddits`:** the communities to search. Add ones where you understand the people, e.g. `"DJs"`, `"weddingplanning"`, `"barbers"`, `"truckers"`, `"Etsy"`.
- **`focus_words`:** only keep posts mentioning these words, e.g. `["music", "band", "gig"]`.
- **`days`:** how far back to look (default 30).

You can also focus a single run without editing anything:

```bash
python -m gapfinder --focus music --focus band
```

## Run it weekly, automatically

Weekly is plenty: you want to see needs build up, not every single post.

- **Mac:** run `crontab -e` and add `0 9 * * 1 cd /path/to/folder && python3 -m gapfinder`. That runs it Mondays at 9am.
- **Windows:** open Task Scheduler, choose **Create Basic Task → Weekly**, set the program to `python`, the arguments to `-m gapfinder`, and **Start in** to the project folder.

To get it by email, fill in the `[email]` section of your config. For Gmail, create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords); never use your normal password there.

## Reading the report: what makes a good opportunity

The best ones have most of these:

1. **Asked more than once,** ideally in **different communities**.
2. **"would pay"** in the tags. People saying they'd pay is the strongest sign there is.
3. **Something simple:** "text my clients when an invoice is overdue" is buildable; "an app that runs my whole business" isn't.
4. **People you understand.** You'll know how to reach them and what they'd pay.

When one keeps showing up week after week, bring it here and we'll work out whether it's worth building, and build it.

**One thing to check:** sometimes a tool already exists and the people asking just haven't heard of it. Before building, search for it. If what exists is expensive, complicated or bad, that's still an opportunity. If something cheap and good already exists, move on.

## Troubleshooting

- **"[reddit] r/xyz: failed (HTTP Error 429)":** Reddit is asking it to slow down. Run it less often, or remove a few subreddits.
- **"[reddit] r/xyz: failed (HTTP Error 404)" or "403":** the subreddit name is misspelled, private or banned.
- **Few results:** add more subreddits, raise `days`, or remove `focus_words`.

## Tests

```bash
python -m unittest
```
