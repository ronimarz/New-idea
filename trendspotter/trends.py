"""Turn chart snapshots into a ranked list of songs that are rising.

A song scores points for how far it climbed on each chart (as a share of the chart, so
climbing 30 places on a 50-song chart counts more than on a 200-song chart), more for
climbing on several charts at once, and less once it's already a top-10 hit or has been
charting for months: by then everyone knows it and the templates already exist.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

from .sources import ChartEntry

HISTORY_DAYS = 60
TOP_HIT_RANK = 10       # already a hit at or above this rank
OLD_SONG_DAYS = 60      # charting this long means it's not news
MULTI_CHART_BONUS = 15  # per extra chart the song is climbing on

_FEAT = re.compile(r"\s*[\(\[](?:feat\.?|ft\.?|featuring|with|w/)\s[^\)\]]*[\)\]]", re.I)
_FIRST_ARTIST = re.compile(r"\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s.*", re.I)


def song_key(artist: str, title: str) -> str:
    """Same song, different chart spelling -> same key. 'Doja Cat & SZA' / 'Kiss Me (feat. X)' -> 'doja cat|kiss me'."""
    a = _FIRST_ARTIST.sub("", artist.lower()).strip()
    t = _FEAT.sub("", title.lower())
    t = re.sub(r"\s+-\s+(?:from|feat).*$", "", t)
    clean = lambda s: " ".join(re.sub(r"[^\w\s]", " ", s).split())
    return f"{clean(a)}|{clean(t)}"


# ---------------------------------------------------------------- history


def snapshot(entries: list[ChartEntry]) -> dict:
    snap: dict[str, dict[str, int]] = {}
    for e in entries:
        snap.setdefault(e.source, {}).setdefault(song_key(e.artist, e.title), e.rank)
    return snap


def add_snapshot(history: dict, today: dt.date, entries: list[ChartEntry]) -> dict:
    history = dict(history)
    history[today.isoformat()] = snapshot(entries)
    cutoff = (today - dt.timedelta(days=HISTORY_DAYS)).isoformat()
    return {d: s for d, s in sorted(history.items()) if d >= cutoff}


def past_snapshot(history: dict, source: str, today: dt.date, lookback: int) -> dict | None:
    """The chart as it was about `lookback` days ago: the newest snapshot at least that old,
    or failing that the oldest one from before today."""
    older = [(d, s[source]) for d, s in sorted(history.items())
             if d < today.isoformat() and source in s]
    if not older:
        return None
    target = (today - dt.timedelta(days=lookback)).isoformat()
    at_least = [s for d, s in older if d <= target]
    return at_least[-1] if at_least else older[0][1]


def first_seen(history: dict, key: str) -> str:
    return next((d for d, s in sorted(history.items()) if any(key in chart for chart in s.values())), "")


# ---------------------------------------------------------------- scoring


@dataclass
class Climb:
    source: str
    rank: int
    places: int        # how far it climbed (chart size + 1 - rank for a new entry)
    new: bool


@dataclass
class Trend:
    key: str
    artist: str
    title: str
    score: float = 0.0
    climbs: list[Climb] = field(default_factory=list)
    best_rank: int = 10_000
    days: int | None = None
    first_seen: str = ""
    notes: list[str] = field(default_factory=list)


def find_trends(entries: list[ChartEntry], history: dict, today: dt.date, lookback: int = 3) -> list[Trend]:
    trends: dict[str, Trend] = {}
    pasts = {src: past_snapshot(history, src, today, lookback) for src in {e.source for e in entries}}

    for e in entries:
        key = song_key(e.artist, e.title)
        t = trends.setdefault(key, Trend(key, e.artist, e.title))
        if any(c.source == e.source for c in t.climbs):
            continue  # same song listed twice on one chart (e.g. a remix); keep the higher one
        t.best_rank = min(t.best_rank, e.rank)
        if e.days is not None:
            t.days = max(t.days or 0, e.days)

        past = pasts[e.source]
        if past is not None:
            before = past.get(key)
            new = before is None
            places = (e.chart_size + 1 - e.rank) if new else before - e.rank
        elif e.is_new:
            new, places = True, e.chart_size + 1 - e.rank
        elif e.move is not None:
            new, places = False, e.move
        else:
            continue  # first run for this chart and it doesn't say what moved: nothing to compare yet
        t.climbs.append(Climb(e.source, e.rank, min(places, e.chart_size), new))

    results = []
    for t in trends.values():
        rising = [c for c in t.climbs if c.places > 0]
        if not rising:
            continue
        sizes = {e.source: e.chart_size for e in entries}
        t.score = sum(100 * c.places / max(sizes[c.source], 1) for c in rising)
        t.score += MULTI_CHART_BONUS * (len(rising) - 1)
        if t.best_rank <= TOP_HIT_RANK:
            t.score *= 0.5
            t.notes.append("already a top-10 hit")
        if t.days and t.days > OLD_SONG_DAYS:
            t.score *= 0.5
            t.notes.append(f"charting for {t.days} days")
        if len(rising) > 1:
            t.notes.insert(0, f"rising on {len(rising)} charts")
        t.score = round(t.score, 1)
        t.first_seen = first_seen(history, t.key)
        results.append(t)
    return sorted(results, key=lambda t: -t.score)
