"""Profit math and deciding whether a listing is worth buying."""

from __future__ import annotations

from dataclasses import dataclass

from .web import Listing, has_any

# Words that usually mean the item is broken, incomplete or not the item itself.
DEFAULT_EXCLUDE = [
    "broken", "for parts", "parts only", "not working", "doesn't work", "does not work", "as is", "as-is",
    "cracked", "locked", "icloud", "box only", "empty box", "case only", "manual only", "wanted", "wtb",
    "looking for", "iso", "trade only", "rent", "rental", "repair",
]


@dataclass
class Item:
    """One thing on your watchlist."""
    name: str
    search: str
    resale: float = 0.0          # what it typically sells for (your own estimate, or filled from eBay)
    must_include: tuple = ()     # every listing title must contain all of these
    exclude: tuple = ()          # skip listings whose title has any of these
    shipping: float | None = None  # overrides [selling] shipping for this item
    min_price: float | None = None  # ignore cheaper listings (accessories, parts); default 20% of resale

    @classmethod
    def from_cfg(cls, d: dict) -> "Item":
        return cls(
            name=d["name"],
            search=d.get("search", d["name"]),
            resale=float(d.get("resale", 0)),
            must_include=tuple(d.get("must_include", ())),
            exclude=tuple(d.get("exclude", ())),
            shipping=d.get("shipping"),
            min_price=d.get("min_price"),
        )

    @property
    def floor(self) -> float:
        return self.min_price if self.min_price is not None else self.resale * 0.2


@dataclass
class Selling:
    fee_percent: float = 0.0   # 0 when selling locally for cash; ~13.6 on eBay
    fee_fixed: float = 0.0     # eBay adds about $0.40 per order
    shipping: float = 0.0      # what you pay to ship it, if the buyer doesn't
    min_profit: float = 40.0   # skip deals that make less than this

    @classmethod
    def from_cfg(cls, d: dict) -> "Selling":
        return cls(**{k: float(d[k]) for k in ("fee_percent", "fee_fixed", "shipping", "min_profit") if k in d})

    def net(self, resale: float, shipping: float | None = None) -> float:
        """What you actually pocket from a sale at this price, before subtracting what you paid."""
        ship = self.shipping if shipping is None else shipping
        return resale * (1 - self.fee_percent / 100) - self.fee_fixed - ship

    def max_buy(self, resale: float, shipping: float | None = None) -> float:
        """The most you can pay and still make min_profit."""
        return round(self.net(resale, shipping) - self.min_profit, 2)


@dataclass
class Deal:
    item: Item
    listing: Listing
    profit: float
    margin: float     # profit as a share of what you pay
    suspicious: bool  # priced so low it may be a scam, stolen, or broken


def evaluate(item: Item, listing: Listing, selling: Selling, extra_exclude=()) -> Deal | None:
    title = listing.title
    if not item.resale or listing.price <= 0 or listing.price < item.floor:
        return None
    if item.must_include and not all(has_any(title, [w]) for w in item.must_include):
        return None
    if has_any(title, [*DEFAULT_EXCLUDE, *extra_exclude, *item.exclude]):
        return None
    profit = round(selling.net(item.resale, item.shipping) - listing.price, 2)
    if profit < selling.min_profit:
        return None
    return Deal(item, listing, profit, round(profit / listing.price, 2), listing.price < item.resale * 0.35)
