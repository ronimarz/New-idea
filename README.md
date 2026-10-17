# avjobs: find jobs with AV duties

> Also in this repo: **[gapfinder](GAPFINDER.md)**, which finds things people keep asking for online that nobody offers well yet.

`avjobs` searches job boards and company career pages, then reads every job description. It keeps only the postings whose duties involve **AV (audio-visual) work** and ranks them by how much of the job is AV.

You get:

- **A scored list in the terminal.** Higher scores mean AV is a bigger part of the job.
- **An HTML report.** Each posting shows the actual duty sentences that mention AV, with matches highlighted. Postings are tagged by type of work (Control & DSP, Conferencing, Installation, Live events, Broadcast & streaming, Support & maintenance, Certification). You can filter by keyword, location or score, and show only new postings.
- **A CSV** you can open in Excel or Google Sheets.
- **A "NEW" flag** on postings you haven't seen in a previous run, so you can rerun it daily and only read what changed.

It recognizes AV gear and skills such as Crestron, Extron, Q-SYS, Biamp, Dante, AMX, Zoom/Teams Rooms, CTS/AVIXA, signal flow, rack builds, live sound, mixing consoles, video switchers and PTZ cameras. It also avoids false matches: "AV" meaning antivirus, "av" inside words like "available", and medical uses.

If "AV" means **autonomous vehicles** for you, run it with `--profile autonomous`.

## Setup

You need Python 3.11 or newer. No other packages are required.

```bash
cp config.example.toml config.toml   # then edit it
python -m avjobs
```

## Where it looks for jobs

| Source | Key needed? | What it covers |
|---|---|---|
| `company_sites` | no | Any company website you list. It finds the careers page and reads the jobs (see below). |
| `greenhouse`, `lever`, `ashby` | no | Company job boards, if you already know the board name (the "slug" in the careers URL). |
| `remotive` | no | Remote jobs. |
| `adzuna` | free key | Large aggregator: many employers, searchable by city. Get a key at [developer.adzuna.com](https://developer.adzuna.com). |
| `usajobs` | free key | US federal jobs, which include many AV and media roles. Get a key at [developer.usajobs.gov](https://developer.usajobs.gov/APIRequest/Index). |

For the widest search, get the free Adzuna key and set `where = "Your City, ST"`.

## Searching company career pages directly

List company websites in `config.toml`:

```toml
[company_sites]
sites = ["https://www.avispl.com", "https://www.crestron.com", "yourlocaluniversity.edu"]
```

Or pass them on the command line:

```bash
python -m avjobs --site avispl.com --site freeman.com
```

For each site, the tool:

1. Finds the careers page. It follows "Careers" / "Jobs" / "Join us" links from the homepage, goes one level deeper for links like "See open positions", and tries `/careers` and `/jobs` if nothing is linked.
2. Detects the hiring system behind that page: Greenhouse, Lever, Ashby, Workday or SmartRecruiters.
3. Pulls the openings from that system. If the company hosts its own job pages, it reads the job listing data many career sites publish for Google Jobs.

To see which job board a company uses without running a full search:

```bash
python -m avjobs --find-board example.com
```

If it says no board was found, the careers page is probably built in a way the tool can't read (for example, a page that only works with JavaScript running, or an iCIMS or Taleo site). Open that one in a browser.

## Useful options

```bash
python -m avjobs --min-score 15           # only jobs where AV is the core of the role
python -m avjobs --min-score 3            # include roles with a little AV (office/IT jobs, etc.)
python -m avjobs --source company_sites   # only search your list of company sites
python -m avjobs --profile autonomous     # AV = autonomous vehicles
```

Tune the results in `config.toml`:

- `extra_terms` adds brands or skills you care about, such as `["Barco", "Disguise", "d&b audiotechnik"]`.
- `location_include` keeps only certain cities or "Remote".

You can also add or reweight keywords in `avjobs/keywords.py`.

## How scoring works

Each AV term has a weight. A Crestron or "audio visual" mention is worth more than a passing mention of "conference room". A match in the job title counts double. Repeated mentions add a little, with diminishing returns. Signs that "AV" means something else (antivirus, self-driving, medical) subtract points.

As a rough guide:

- **6+** means AV is a real part of the job.
- **15+** means AV is the job.

## Tests

```bash
python -m unittest
```
