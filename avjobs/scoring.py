"""Score job postings by how much AV work their duties describe."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

from .keywords import CASE_SENSITIVE, PROFILES

_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_TAG_RE = re.compile(r"</?(?:p|div|li|ul|ol|br|h\d|tr)[^>]*>", re.I)
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_SENTENCE_SPLIT_RE = re.compile(r"\n+|(?<=[.!?;])\s+(?=[A-Z])")


def html_to_text(raw: str) -> str:
    """Strip HTML (including entity-escaped HTML, as Greenhouse returns) to plain text."""
    if not raw:
        return ""
    text = html.unescape(raw)
    if "<" in text:
        text = _BLOCK_TAG_RE.sub("\n", text)
        text = _TAG_RE.sub(" ", text)
        text = html.unescape(text)
    lines = (_WS_RE.sub(" ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


@dataclass
class Score:
    total: float
    tags: list[str]
    matched_terms: list[str]
    snippets: list[str] = field(default_factory=list)


class Scorer:
    def __init__(self, profile: str = "audiovisual", extra_terms: list[str] | None = None):
        if profile not in PROFILES:
            raise ValueError(f"unknown profile {profile!r}; choose from {sorted(PROFILES)}")
        spec = PROFILES[profile]
        self.search_terms: list[str] = list(spec["search_terms"])
        self.terms = [
            (self._compile(pattern), weight, tag) for pattern, weight, tag in spec["terms"]
        ]
        for term in extra_terms or []:
            self.terms.append((re.compile(rf"\b{re.escape(term)}\b", re.I), 3, "Custom"))
        self.negative = [(self._compile(pattern), weight) for pattern, weight in spec["negative"]]

    @staticmethod
    def _compile(pattern: str) -> re.Pattern:
        return re.compile(pattern, 0 if pattern in CASE_SENSITIVE else re.I)

    def score(self, title: str, description: str, max_snippets: int = 3) -> Score:
        total = 0.0
        tags: dict[str, float] = {}
        matched: list[str] = []
        for regex, weight, tag in self.terms:
            title_hits = len(regex.findall(title))
            body_hits = len(regex.findall(description))
            if not (title_hits or body_hits):
                continue
            # Diminishing returns on repeats, double weight for the job title.
            points = weight * (1 + 0.5 * (min(body_hits, 3) - 1)) if body_hits else 0
            points += 2 * weight if title_hits else 0
            total += points
            tags[tag] = tags.get(tag, 0) + points
            hit = regex.search(title) or regex.search(description)
            matched.append(hit.group(0))
        haystack = f"{title}\n{description}"
        for regex, weight in self.negative:
            total -= weight * len(regex.findall(haystack))
        ranked_tags = [t for t, _ in sorted(tags.items(), key=lambda kv: -kv[1])]
        return Score(
            total=round(max(total, 0.0), 1),
            tags=ranked_tags,
            matched_terms=sorted(set(matched), key=str.lower),
            snippets=self.snippets(description, max_snippets) if total > 0 else [],
        )

    def snippets(self, description: str, limit: int = 3) -> list[str]:
        """Return the sentences/bullets that cover the most distinct AV duties.

        Picked greedily so the snippets show different kinds of AV work
        rather than three bullets about the same thing.
        """
        candidates = []
        for i, sentence in enumerate(_SENTENCE_SPLIT_RE.split(description)):
            sentence = sentence.strip(" -•*\t")
            if len(sentence) < 15:
                continue
            hits = {}
            for regex, w, tag in self.terms:
                if regex.search(sentence):
                    hits[tag] = hits.get(tag, 0) + w
            if hits:
                candidates.append((i, sentence[:300], hits))
        chosen, covered = [], set()
        while candidates and len(chosen) < limit:
            gain = lambda c: (sum(w for t, w in c[2].items() if t not in covered), sum(c[2].values()), -c[0])
            best = max(candidates, key=gain)
            candidates.remove(best)
            chosen.append(best)
            covered.update(best[2])
        return [s for _, s, _ in sorted(chosen)]

    def highlight_regexes(self) -> list[re.Pattern]:
        return [regex for regex, _, _ in self.terms]
