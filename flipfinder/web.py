"""Fetch pages from marketplace sites and parse their listings into Listing records.

craigslist  search results for a city (no account or key needed)
ebay        recently SOLD listings, used to estimate what an item really resells for
"""

from __future__ import annotations

import html
import re
import statistics
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

# Marketplaces serve stripped-down or blocked pages to unknown clients, so look like a normal browser.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass
class Listing:
    source: str
    title: str
    price: float
    url: str
    location: str = ""

    @property
    def key(self) -> str:
        return self.url or f"{self.source}:{self.title}:{self.price}"


Fetcher = Callable[[str], str]


def http_get_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode(resp.headers.get_content_charset() or "utf-8", "replace")


def warn(msg: str) -> None:
    print(msg, file=sys.stderr)


def parse_price(text: str) -> float | None:
    """'$1,250.00' -> 1250.0. Ranges like '$20.00 to $35.00' return None (multi-variant listings)."""
    text = html.unescape(text)
    if re.search(r"\bto\b", text):
        return None
    m = re.search(r"\$\s*([\d,]+(?:\.\d+)?)", text)
    return float(m.group(1).replace(",", "")) if m else None


def _text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


# ---------------------------------------------------------------- craigslist


def craigslist_url(city: str, query: str, cfg: dict) -> str:
    params = {"query": query, "sort": "date", "min_price": cfg.get("min_price", 5)}
    if cfg.get("max_price"):
        params["max_price"] = cfg["max_price"]
    if cfg.get("zip"):
        params["postal"] = cfg["zip"]
        params["search_distance"] = cfg.get("miles", 25)
    if cfg.get("owner_only", True):
        params["purveyor"] = "owner"  # skip dealers, who rarely price below market
    category = cfg.get("category", "sss")  # sss = all for sale
    return f"https://{city}.craigslist.org/search/{category}?{urllib.parse.urlencode(params)}"


_CL_ITEM = re.compile(r'<li[^>]*class="cl-static-search-result"[^>]*>(.*?)</li>', re.S)


def parse_craigslist(page: str) -> list[Listing]:
    """Craigslist pages include a plain-HTML copy of the results for browsers without JavaScript."""
    out = []
    for block in _CL_ITEM.findall(page):
        href = re.search(r'href="([^"]+)"', block)
        title = re.search(r'class="title"[^>]*>(.*?)</div>', block, re.S)
        price = re.search(r'class="price"[^>]*>(.*?)</div>', block, re.S)
        where = re.search(r'class="location"[^>]*>(.*?)</div>', block, re.S)
        value = parse_price(price.group(1)) if price else None
        if not (href and title and value):
            continue
        out.append(Listing("craigslist", _text(title.group(1)), value, html.unescape(href.group(1)),
                           _text(where.group(1)) if where else ""))
    return out


def fetch_craigslist(cfg: dict, query: str, get: Fetcher = http_get_text) -> list[Listing]:
    city = cfg.get("city")
    if not city:
        raise ValueError('set [craigslist] city, e.g. city = "chicago" (the part before .craigslist.org)')
    return parse_craigslist(get(craigslist_url(city, query, cfg)))


# ---------------------------------------------------------------- ebay sold prices


def ebay_sold_url(query: str, used_only: bool = True) -> str:
    params = {"_nkw": query, "LH_Sold": 1, "LH_Complete": 1, "_ipg": 120}
    if used_only:
        params["LH_ItemCondition"] = 3000
    return "https://www.ebay.com/sch/i.html?" + urllib.parse.urlencode(params)


_EBAY_ITEM = re.compile(r'<li[^>]*class="[^"]*\bs-(?:item|card)\b[^"]*"[^>]*>(.*?)(?=<li[^>]*class="[^"]*\bs-(?:item|card)\b|</ul>)', re.S)
_EBAY_TITLE = re.compile(r'class="[^"]*\bs-(?:item__title|card__title)\b[^"]*"[^>]*>(.*?)</(?:div|h3|span)>', re.S)
_EBAY_PRICE = re.compile(r'class="[^"]*\bs-(?:item__price|card__price)\b[^"]*"[^>]*>(.*?)</span>', re.S)


def parse_ebay_sold(page: str, exclude: list[str] = ()) -> list[tuple[str, float]]:
    out = []
    for block in _EBAY_ITEM.findall(page):
        title, price = _EBAY_TITLE.search(block), _EBAY_PRICE.search(block)
        if not (title and price):
            continue
        name = re.sub(r"^New Listing\s*", "", _text(title.group(1)))
        value = parse_price(price.group(1))
        if not value or name.lower().startswith("shop on ebay") or has_any(name, exclude):
            continue
        out.append((name, value))
    return out


def typical_price(prices: list[float]) -> float | None:
    """Median after dropping the cheapest and priciest 10% (odd lots, bundles) and anything
    under 40% of the median (accessories and parts that slipped through the title filters)."""
    if len(prices) < 3:
        return None
    prices = sorted(prices)
    cut = len(prices) // 10
    prices = prices[cut: len(prices) - cut]
    floor = statistics.median(prices) * 0.4
    return round(statistics.median([p for p in prices if p >= floor]), 2)


def ebay_resale(query: str, exclude=(), must_include=(), min_price: float = 0,
                get: Fetcher | None = None) -> tuple[float | None, int]:
    """(typical sold price, number of sales it is based on)."""
    sold = parse_ebay_sold((get or http_get_text)(ebay_sold_url(query)), exclude)
    prices = [p for t, p in sold if p >= min_price and all(has_any(t, [w]) for w in must_include)]
    return typical_price(prices), len(prices)


def has_any(text: str, words) -> bool:
    text = text.lower()
    return any(re.search(rf"(?<!\w){re.escape(w.lower())}(?!\w)", text) for w in words)
