"""Spot posts where someone wants something that doesn't exist (or isn't good enough),
then group posts asking for the same thing so repeated demand stands out."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .sources import Post

_THING = r"(?:app|apps|tool|tools|service|website|site|program|software|plugin|extension|platform|product|bot)"

# (label, weight, patterns). Weight says how strong a sign of real demand it is.
SIGNALS = [
    ("would pay", 4, [
        r"\bi'?d (?:happily |gladly )?pay\b", r"\bi would (?:happily |gladly )?pay\b", r"\bhappy to pay\b",
        r"\btake my money\b", r"\bwould pay (?:for|good money|\$)", r"\bi'?d subscribe\b",
    ]),
    ("nothing exists", 3, [
        r"\bwhy (?:is|isn'?t) there (?:no|not|an?)\b", r"\bsomeone (?:should|needs to) (?:make|build|create)\b",
        r"\bi wish there (?:was|were)\b", r"\bwish there (?:was|were) (?:an?|some)\b",
        rf"\bcan'?t find (?:any|an?|a good) (?:\w+ )?{_THING}", r"\bnothing (?:out there|exists)\b",
    ]),
    ("looking for a tool", 2, [
        rf"\bis there (?:an?|any) (?:\w+ )?(?:{_THING}|way to)\b",
        rf"\bdoes anyone know (?:of )?(?:an?|any) (?:\w+ )?{_THING}", rf"\blooking for (?:an?|some) (?:\w+ )?{_THING}",
        rf"\b(?:recommend|suggest) (?:an?|any) (?:\w+ )?{_THING}", rf"\bany {_THING} (?:that|which|for)\b",
    ]),
    ("switching away", 2, [
        r"\bshutting down\b", r"\b(?:is|was|got|being) discontinued\b", r"\b(?:raised|raising|hiked|doubled) (?:their |the |its )?prices?\b",
        r"\bprice (?:increase|hike)\b", r"\balternatives? (?:to|for)\b", r"\breplacement for\b",
    ]),
    ("frustrated", 1, [
        r"\bso frustrating\b", r"\bi hate (?:that|how|when)\b", r"\bdrives me (?:crazy|nuts)\b",
        r"\bwastes? (?:so much|hours|hours of)\b", r"\bthere has to be a better way\b",
    ]),
]
_COMPILED = [(label, weight, [re.compile(p, re.I) for p in pats]) for label, weight, pats in SIGNALS]

STOPWORDS = set("""
a about above after again against all also am an and any anyone anything are aren't as at be because been before
being below between both but by can can't could did didn't do does doesn't doing don't down during each else even
every few find for from further get gets getting go going good got had has have having he her here hers how i i'd
i'm i've if in into is isn't it it's its just know let like looking lot make many me might more most much must my
need needs new no nor not now of off on once one only or other our out over own people pay really same see
should so some someone something such than that that's the their them then there there's these they thing things
this those through to too try trying under until up us use used using very want wants was way we well were what
when where which while who why will wish with without would wouldn't yes yet you your
app apps tool tools service website site program software plugin extension platform product bot
anybody recommend recommendation recommendations suggest suggestions help please thanks question ask
better best free simple easy work works working exist exists existing built build create made
""".split())


@dataclass
class Hit:
    post: Post
    strength: float
    labels: list[str]
    quote: str  # the sentence that shows what they want


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def detect(post: Post, focus_words=()) -> Hit | None:
    full = f"{post.title}{' ' if post.title.rstrip()[-1:] in '.?!' else '. '}{post.text}"
    if focus_words and not any(re.search(rf"\b{re.escape(w)}", full, re.I) for w in focus_words):
        return None
    labels, strength, quote = [], 0.0, ""
    for label, weight, patterns in _COMPILED:
        for pat in patterns:
            m = pat.search(full)
            if m:
                labels.append(label)
                strength += weight
                if not quote:
                    quote = next((s for s in _sentences(full) if pat.search(s)), m.group())
                break
    if post.always_request and "looking for a tool" not in labels:
        labels.append("asking for software")
        strength += 2
    if not labels:
        return None
    strength += min(post.score, 100) ** 0.5 / 2  # upvotes count a little, with diminishing returns
    return Hit(post, round(strength, 1), labels, (quote or post.title)[:300])


# ---------------------------------------------------------------- grouping


def terms(text: str) -> set[str]:
    words = re.findall(r"[a-z][a-z0-9'+-]{2,}", text.lower())
    out = set()
    for w in words:
        w = re.sub(r"'s$", "", w).strip("'-")
        if w in STOPWORDS or len(w) < 3:
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.add(w)
    return out


@dataclass
class Group:
    hits: list[Hit] = field(default_factory=list)
    term_counts: Counter = field(default_factory=Counter)

    @property
    def keywords(self) -> list[str]:
        return [t for t, n in self.term_counts.most_common(6) if n > 1 or len(self.hits) == 1][:5]

    @property
    def headline(self) -> Hit:
        return max(self.hits, key=lambda h: h.strength)

    @property
    def communities(self) -> list[str]:
        return sorted({h.post.community for h in self.hits})

    @property
    def score(self) -> float:
        spread = 1 + 0.25 * (len(self.communities) - 1)  # same ask in different places = broader demand
        return round(sum(h.strength for h in self.hits) * spread, 1)

    def similarity(self, ts: set[str]) -> float:
        core = {t for t, _ in self.term_counts.most_common(8)}
        shared = len(core & ts)
        return 0.0 if shared < 2 else shared / len(core | ts)


def group_hits(hits: list[Hit], threshold: float = 0.2) -> list[Group]:
    groups: list[Group] = []
    for hit in sorted(hits, key=lambda h: -h.strength):
        ts = terms(f"{hit.post.title} {hit.quote}")
        best = max(groups, key=lambda g: g.similarity(ts), default=None)
        if best is None or best.similarity(ts) < threshold:
            best = Group()
            groups.append(best)
        best.hits.append(hit)
        best.term_counts.update(ts)
    return sorted(groups, key=lambda g: -g.score)
