"""Fetch recent public posts where people might be asking for something, as Post records.

None of these need an account or API key:
  reddit         public RSS feeds (the same ones news-reader apps use)
  hackernews     Hacker News search (hn.algolia.com)
  stackexchange  Software Recommendations and similar Q&A sites
"""

from __future__ import annotations

import datetime as dt
import gzip
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable

HEADERS = {"User-Agent": "Mozilla/5.0 (gapfinder; personal research tool)"}
ATOM = "{http://www.w3.org/2005/Atom}"

# Searched for on Reddit and Hacker News. Matching posts are then checked locally by signals.py.
SEARCH_PHRASES = [
    "is there an app", "is there a tool", "is there a service", "i'd pay", "i would pay",
    "why is there no", "someone should make", "wish there was",
]


@dataclass
class Post:
    source: str
    community: str
    title: str
    text: str
    url: str
    created: dt.date
    score: int = 0
    always_request: bool = False  # posted somewhere where every post is a request (r/SomebodyMakeThis)


Fetcher = Callable[[str], str]


def http_get_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={**HEADERS, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip" or body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
        return body.decode(resp.headers.get_content_charset() or "utf-8", "replace")


def warn(msg: str) -> None:
    print(msg, file=sys.stderr)


def html_to_text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(fragment or ""))).split())


def _date(value) -> dt.date:
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).date()
    return dt.date.fromisoformat(str(value)[:10])


# ---------------------------------------------------------------- reddit (RSS, no account)


def parse_reddit_rss(feed: str, always_request: bool = False) -> list[Post]:
    root = ET.fromstring(feed)
    posts = []
    for e in root.iter(f"{ATOM}entry"):
        link = e.find(f"{ATOM}link")
        cat = e.find(f"{ATOM}category")
        when = e.findtext(f"{ATOM}published") or e.findtext(f"{ATOM}updated") or ""
        if link is None or not when:
            continue
        text = html_to_text(e.findtext(f"{ATOM}content") or "")
        text = re.sub(r"\s*submitted by /u/\S+.*$", "", text)  # feed footer, not the post
        posts.append(Post("reddit", "r/" + (cat.get("term") if cat is not None else "?"),
                          html.unescape(e.findtext(f"{ATOM}title") or ""), text, link.get("href", ""),
                          _date(when), always_request=always_request))
    return posts


def fetch_reddit(cfg: dict, since: dt.date, get: Fetcher = http_get_text, pause: float = 2.0) -> list[Post]:
    posts: list[Post] = []
    query = " OR ".join(f'"{p}"' for p in cfg.get("phrases", SEARCH_PHRASES))
    request_subs = {s.lower() for s in cfg.get("request_subreddits", [])}
    for i, sub in enumerate([*cfg.get("subreddits", []), *cfg.get("request_subreddits", [])]):
        if i:
            time.sleep(pause)  # Reddit throttles feeds that are hit too quickly
        if sub.lower() in request_subs:
            url = f"https://www.reddit.com/r/{sub}/new/.rss?limit=100"
        else:
            url = f"https://www.reddit.com/r/{sub}/search.rss?" + urllib.parse.urlencode(
                {"q": query, "restrict_sr": 1, "sort": "new", "t": "month", "limit": 100})
        try:
            found = [p for p in parse_reddit_rss(get(url), sub.lower() in request_subs) if p.created >= since]
        except (OSError, ET.ParseError, ValueError) as e:
            warn(f"[reddit] r/{sub}: failed ({e})")
            continue
        posts.extend(found)
    return posts


# ---------------------------------------------------------------- hacker news


def fetch_hackernews(cfg: dict, since: dt.date, get: Fetcher = http_get_text) -> list[Post]:
    stamp = int(dt.datetime.combine(since, dt.time(), dt.timezone.utc).timestamp())
    posts: dict[str, Post] = {}
    for phrase in cfg.get("phrases", SEARCH_PHRASES):
        params = {"query": f'"{phrase}"', "tags": "(story,comment)",
                  "numericFilters": f"created_at_i>{stamp}", "hitsPerPage": 100}
        data = json.loads(get("https://hn.algolia.com/api/v1/search_by_date?" + urllib.parse.urlencode(params)))
        for h in data.get("hits", []):
            title = h.get("title") or h.get("story_title") or ""
            text = html_to_text(h.get("comment_text") or h.get("story_text") or "")
            posts.setdefault(h["objectID"], Post(
                "hackernews", "Hacker News", title, text,
                f"https://news.ycombinator.com/item?id={h['objectID']}",
                _date(h.get("created_at_i") or h.get("created_at")), int(h.get("points") or 0)))
    return list(posts.values())


# ---------------------------------------------------------------- stack exchange


def fetch_stackexchange(cfg: dict, since: dt.date, get: Fetcher = http_get_text) -> list[Post]:
    """Every question on Software Recommendations is someone asking for a tool, so all count."""
    stamp = int(dt.datetime.combine(since, dt.time(), dt.timezone.utc).timestamp())
    posts = []
    for site in cfg.get("sites", ["softwarerecs"]):
        params = {"order": "desc", "sort": "creation", "site": site, "fromdate": stamp,
                  "pagesize": 100, "filter": "withbody"}
        data = json.loads(get("https://api.stackexchange.com/2.3/questions?" + urllib.parse.urlencode(params)))
        if "error_message" in data:
            raise ValueError(data["error_message"])
        for q in data.get("items", []):
            posts.append(Post("stackexchange", site, html.unescape(q.get("title", "")), html_to_text(q.get("body", "")),
                              q.get("link", ""), _date(q["creation_date"]), int(q.get("score", 0)),
                              always_request=True))
    return posts


SOURCES: dict[str, Callable[..., list[Post]]] = {
    "reddit": fetch_reddit,
    "hackernews": fetch_hackernews,
    "stackexchange": fetch_stackexchange,
}
