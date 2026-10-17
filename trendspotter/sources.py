"""Fetch music charts and normalize them into ChartEntry records.

Sources that need no key:    apple (Apple Music Top 100), spotify (Spotify daily chart, via kworb.net)
Source that needs a free key: lastfm (last.fm/api/account/create)
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

HEADERS = {"User-Agent": "Mozilla/5.0 (trendspotter; personal music trend tracker)"}


class SourceSkipped(Exception):
    """A source isn't configured; not an error."""


@dataclass
class ChartEntry:
    source: str
    rank: int
    artist: str
    title: str
    chart_size: int
    url: str = ""
    move: int | None = None  # places climbed since the chart's last update, when the chart says
    is_new: bool = False     # first day on this chart, when the chart says
    days: int | None = None  # days on the chart, when the chart says


Fetcher = Callable[[str], str]


def http_get_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode(resp.headers.get_content_charset() or "utf-8", "replace")


def warn(msg: str) -> None:
    print(msg, file=sys.stderr)


def _text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def _int(text: str) -> int | None:
    m = re.search(r"-?\d[\d,]*", text)
    return int(m.group().replace(",", "")) if m else None


# ---------------------------------------------------------------- apple music


def fetch_apple(cfg: dict, get: Fetcher = http_get_text) -> list[ChartEntry]:
    country = cfg.get("country", "us")
    data = json.loads(get(f"https://rss.applemarketingtools.com/api/v2/{country}/music/most-played/100/songs.json"))
    results = data["feed"]["results"]
    return [ChartEntry("apple", i, r["artistName"], r["name"], len(results), r.get("url", ""))
            for i, r in enumerate(results, 1)]


# ---------------------------------------------------------------- spotify (kworb.net)


def parse_kworb(page: str) -> list[ChartEntry]:
    """kworb's chart pages are one plain table: Pos, P+ (movement), Artist and Title, Days, ..."""
    table = re.search(r"<table.*?</table>", page, re.S | re.I)
    if not table:
        raise ValueError("no chart table found on kworb page")
    headers = [_text(h).lower() for h in re.findall(r"<th[^>]*>(.*?)</th>", table.group(), re.S | re.I)]
    col = lambda *names: next((i for i, h in enumerate(headers) if h in names), None)
    pos_i, move_i, song_i, days_i = col("pos"), col("p+"), col("artist and title", "track"), col("days")
    if pos_i is None or song_i is None:
        raise ValueError(f"unexpected kworb columns: {headers}")

    rows = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(), re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(cells) <= max(pos_i, song_i):
            continue
        rank, song = _int(_text(cells[pos_i])), _text(cells[song_i])
        if not rank or " - " not in song:
            continue
        artist, title = song.split(" - ", 1)
        move_txt = _text(cells[move_i]) if move_i is not None and move_i < len(cells) else ""
        rows.append(ChartEntry(
            "spotify", rank, artist, title, 0,
            move=0 if move_txt == "=" else _int(move_txt) if re.fullmatch(r"[+-]\d+", move_txt) else None,
            is_new=move_txt.upper() == "NEW",
            days=_int(_text(cells[days_i])) if days_i is not None and days_i < len(cells) else None,
        ))
    for r in rows:
        r.chart_size = len(rows)
    return rows


def fetch_spotify(cfg: dict, get: Fetcher = http_get_text) -> list[ChartEntry]:
    country = cfg.get("country", "us")
    return parse_kworb(get(f"https://kworb.net/spotify/country/{country}_daily.html"))


# ---------------------------------------------------------------- last.fm


def fetch_lastfm(cfg: dict, get: Fetcher = http_get_text) -> list[ChartEntry]:
    key = cfg.get("api_key")
    if not key:
        raise SourceSkipped("set [lastfm] api_key (free at last.fm/api/account/create)")
    params = {"method": "geo.gettoptracks", "country": cfg.get("country", "united states"),
              "api_key": key, "format": "json", "limit": 100}
    data = json.loads(get("https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode(params)))
    tracks = data.get("tracks", {}).get("track", [])
    return [ChartEntry("lastfm", i, t["artist"]["name"], t["name"], len(tracks), t.get("url", ""))
            for i, t in enumerate(tracks, 1)]


SOURCES: dict[str, Callable[..., list[ChartEntry]]] = {
    "apple": fetch_apple,
    "spotify": fetch_spotify,
    "lastfm": fetch_lastfm,
}
