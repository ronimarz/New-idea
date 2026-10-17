"""Command-line entry point.

python -m flipfinder                       scan Craigslist for underpriced items on your watchlist
python -m flipfinder check "dyson v8" 60   is this listing (from anywhere) worth buying at $60?
python -m flipfinder price "dyson v8"      what does it typically sell for on eBay?
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import tomllib
import urllib.error
from pathlib import Path

from . import web
from .deals import DEFAULT_EXCLUDE, Deal, Item, Selling, evaluate
from .report import write_csv, write_html
from .web import warn

DEFAULT_CONFIG = Path("flipfinder.toml")
PRICE_CACHE_DAYS = 7
NET_ERRORS = (urllib.error.URLError, TimeoutError, ValueError)


def load_config(path: Path) -> dict:
    if not path.exists():
        example = Path(__file__).resolve().parent.parent / "flipfinder.example.toml"
        warn(f"No {path} found - using {example.name}. Copy it to {path} to customize.")
        path = example
    with path.open("rb") as f:
        return tomllib.load(f)


class PriceBook:
    """eBay sold-price lookups, cached on disk for a week so repeat runs are fast and polite."""

    def __init__(self, path: Path, exclude: list[str], get=None):
        self.path, self.exclude, self.get = path, exclude, get or web.http_get_text
        self.cache = json.loads(path.read_text()) if path.exists() else {}

    def lookup(self, query: str, item: Item | None = None) -> tuple[float | None, int]:
        key = query.lower().strip()
        hit = self.cache.get(key)
        if hit and dt.date.fromisoformat(hit["date"]) >= dt.date.today() - dt.timedelta(days=PRICE_CACHE_DAYS):
            return hit["price"], hit["sales"]
        item = item or Item(name=query, search=query)
        price, sales = web.ebay_resale(query, [*self.exclude, *item.exclude], item.must_include,
                                       item.min_price or 0, self.get)
        if price:
            self.cache[key] = {"price": price, "sales": sales, "date": dt.date.today().isoformat()}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.cache, indent=1))
        return price, sales


def fill_resale(items: list[Item], prices: PriceBook) -> None:
    """Use what each item has actually been selling for on eBay. The resale in your config is the fallback."""
    for item in items:
        try:
            price, sales = prices.lookup(item.search, item)
        except NET_ERRORS as e:
            price, sales = None, 0
            warn(f"[ebay] {item.name}: price lookup failed ({e})")
        if price:
            item.resale = price
            warn(f"[ebay] {item.name}: typically sells for ${price:,.0f} ({sales} recent sales)")
        elif item.resale:
            warn(f"[ebay] {item.name}: using your config price ${item.resale:,.0f}")
        else:
            warn(f"[ebay] {item.name}: no price found - set resale for it in your config")


def scan(cfg: dict, items: list[Item], selling: Selling, out: Path, top: int, get=None) -> int:
    get = get or web.http_get_text
    extra_exclude = cfg.get("exclude", [])
    cl_cfg = cfg.get("craigslist", {})
    deals: dict[str, Deal] = {}
    for item in items:
        if not item.resale:
            warn(f"[skip] {item.name}: no resale price")
            continue
        try:
            listings = web.fetch_craigslist(cl_cfg, item.search, get)
        except NET_ERRORS as e:
            warn(f"[craigslist] {item.name}: failed ({e})")
            continue
        found = [d for d in (evaluate(item, l, selling, extra_exclude) for l in listings) if d]
        warn(f"[craigslist] {item.name}: {len(listings)} listings, {len(found)} deals (buy under ${selling.max_buy(item.resale, item.shipping):,.0f})")
        for d in found:
            if d.listing.key not in deals or d.profit > deals[d.listing.key].profit:
                deals[d.listing.key] = d
    results = sorted(deals.values(), key=lambda d: -d.profit)

    out.mkdir(parents=True, exist_ok=True)
    seen_path = out / "seen.json"
    seen = set(json.loads(seen_path.read_text())) if seen_path.exists() else set()
    rows = [(d, d.listing.key not in seen) for d in results]
    seen_path.write_text(json.dumps(sorted(seen | deals.keys()), indent=0))

    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    html_path, csv_path = out / f"deals_{stamp}.html", out / f"deals_{stamp}.csv"
    run_info = f"{dt.datetime.now():%b %d, %Y %I:%M %p} · {len(items)} items watched · min profit ${selling.min_profit:,.0f}"
    write_html(html_path, rows, run_info)
    write_csv(csv_path, rows)

    new_count = sum(1 for _, is_new in rows if is_new)
    print(f"\n{len(rows)} deal{'' if len(rows) == 1 else 's'} ({new_count} new)\n")
    for d, is_new in rows[:top]:
        flag = "NEW " if is_new else "    "
        caution = "  (check it carefully: unusually cheap)" if d.suspicious else ""
        print(f"{flag}+${d.profit:<6,.0f} pay ${d.listing.price:<6,.0f} {d.listing.title[:55]:<55} {d.listing.location[:20]}{caution}")
        print(f"      {d.listing.url}")
    print(f"\nFull report: {html_path}\nSpreadsheet: {csv_path}")
    return 0


def find_item(items: list[Item], name: str) -> Item | None:
    name = name.lower()
    for item in items:
        if name in (item.name.lower(), item.search.lower()):
            return item
    words = set(name.split())
    for item in items:
        if words and words <= set(item.name.lower().split()) | set(item.search.lower().split()):
            return item
    return None


def check(name: str, asking: float, items: list[Item], selling: Selling, prices: PriceBook, use_ebay: bool) -> int:
    item = find_item(items, name) or Item(name=name, search=name)
    resale, basis, problem = None, "", ""
    if use_ebay:
        try:
            resale, sales = prices.lookup(item.search, item)
            basis = f"median of {sales} recent eBay sales"
        except NET_ERRORS as e:
            problem = f"Couldn't look up eBay prices ({e})."
    if not resale and item.resale:
        resale, basis = item.resale, f"your watchlist price for {item.name}"
    if not resale:
        print(problem or f'Not enough eBay sales found for "{name}". Try a more specific name, e.g. "dewalt dcd771".')
        print("You can also add it to your watchlist with a resale price.")
        return 1
    profit = round(selling.net(resale, item.shipping) - asking, 2)
    max_buy = selling.max_buy(resale, item.shipping)
    outcome = f"profit is ${profit:,.0f}" if profit >= 0 else f"you'd lose ${-profit:,.0f}"
    print(f"Resells for about ${resale:,.0f} ({basis})")
    print(f"After fees/shipping you'd net ${selling.net(resale, item.shipping):,.0f}, so at ${asking:,.0f} {outcome}")
    if profit >= selling.min_profit:
        print(f"BUY. It clears your ${selling.min_profit:,.0f} minimum. Don't pay more than ${max_buy:,.0f}.")
    elif max_buy > 0:
        print(f"PASS at this price. Offer ${max_buy:,.0f} or less.")
    else:
        print("PASS. It doesn't resell for enough to be worth flipping.")
    if asking < resale * 0.35:
        print("Caution: this is unusually cheap. Test it in person, and meet somewhere public.")
    return 0


def price(query: str, selling: Selling, prices: PriceBook) -> int:
    try:
        resale, sales = prices.lookup(query)
    except NET_ERRORS as e:
        print(f"Couldn't reach eBay ({e}).")
        return 1
    if not resale:
        print(f'Not enough eBay sales found for "{query}".')
        return 1
    print(f"{query}: typically sells used for ${resale:,.0f} ({sales} recent eBay sales)")
    print(f"To make ${selling.min_profit:,.0f}+ profit, buy for ${selling.max_buy(resale):,.0f} or less")
    print(f"Check the sales yourself: {web.ebay_sold_url(query)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="flipfinder", description="Find items listed below resale value.")
    p.add_argument("-c", "--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--out", type=Path, default=Path("deals"))
    p.add_argument("--top", type=int, default=20, help="how many deals to print in the terminal")
    p.add_argument("--min-profit", type=float, help="skip deals making less than this")
    p.add_argument("--no-ebay", action="store_true", help="skip eBay lookups and use the resale prices in your config")
    sub = p.add_subparsers(dest="command")
    c = sub.add_parser("check", help="should I buy this listing?")
    c.add_argument("item", help='item name, e.g. "dyson v8"')
    c.add_argument("asking", type=float, help="the asking price")
    pr = sub.add_parser("price", help="what does this sell for on eBay?")
    pr.add_argument("item")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    selling = Selling.from_cfg(cfg.get("selling", {}))
    if args.min_profit is not None:
        selling.min_profit = args.min_profit
    items = [Item.from_cfg(d) for d in cfg.get("items", [])]
    prices = PriceBook(args.out / "prices.json", [*DEFAULT_EXCLUDE, *cfg.get("exclude", [])])
    use_ebay = cfg.get("use_ebay_prices", True) and not args.no_ebay

    if args.command == "check":
        return check(args.item, args.asking, items, selling, prices, use_ebay)
    if args.command == "price":
        return price(args.item, selling, prices)
    if not items:
        print("Your watchlist is empty. Add [[items]] to your config.")
        return 1
    if use_ebay:
        fill_resale(items, prices)
    return scan(cfg, items, selling, args.out, args.top)


if __name__ == "__main__":
    sys.exit(main())
