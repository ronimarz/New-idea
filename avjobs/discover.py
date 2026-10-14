"""Find a company's careers page from its website and pull jobs straight from it.

Given "https://www.example.com" (or just "example.com") this:
  1. fetches the homepage and follows links that look like careers/jobs pages,
  2. looks in those pages for the applicant-tracking system (ATS) they embed
     or link to - Greenhouse, Lever, Ashby, Workday, SmartRecruiters - and
  3. reads the jobs from that ATS's public JSON API, or, for a self-hosted
     careers page, from the schema.org JobPosting data many sites publish.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser

from . import sources
from .scoring import html_to_text
from .sources import USER_AGENT, Job, http_get_json, warn

CAREER_LINK_RE = re.compile(r"career|jobs?\b|join[-\s]?us|work[-\s]?(?:with|for)[-\s]?us|openings|opportunities|employment", re.I)
COMMON_CAREER_PATHS = ["/careers", "/jobs", "/careers/", "/about/careers", "/company/careers", "/join-us", "/employment"]

# (ats name, regex over page HTML). Group 1 = board slug; Workday also captures host + site.
ATS_PATTERNS = [
    ("greenhouse", re.compile(r"(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io/(?:embed/job_board(?:/js)?\?for=)?([A-Za-z0-9_-]+)")),
    ("greenhouse", re.compile(r"boards-api\.greenhouse\.io/v1/boards/([A-Za-z0-9_-]+)")),
    ("lever", re.compile(r"jobs(?:\.eu)?\.lever\.co/([A-Za-z0-9_.-]+)")),
    ("ashby", re.compile(r"jobs\.ashbyhq\.com/([A-Za-z0-9_.%-]+)")),
    ("smartrecruiters", re.compile(r"(?:careers|jobs)\.smartrecruiters\.com/([A-Za-z0-9_-]+)")),
    ("workday", re.compile(r"(([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)")),
]
IGNORED_SLUGS = {"embed", "js", "v1", "api", "jobs", "search", "en-US"}


@dataclass(frozen=True)
class Board:
    ats: str
    slug: str
    host: str = ""  # Workday only
    site: str = ""  # Workday only

    def label(self) -> str:
        return f"{self.ats}:{self.host}/{self.site}" if self.ats == "workday" else f"{self.ats}:{self.slug}"


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join(self._text).strip()))
            self._href = None


def fetch_html(url: str, timeout: int = 20) -> tuple[str, str]:
    """Return (final_url, html)."""
    req = urllib.request.Request(url, headers={"User-Agent": f"Mozilla/5.0 {USER_AGENT}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.geturl(), resp.read(3_000_000).decode(charset, errors="replace")


def normalize_site(site: str) -> str:
    site = site.strip()
    if not re.match(r"https?://", site):
        site = "https://" + site
    return site


def career_page_candidates(base_url: str, page_html: str, limit: int = 4) -> list[str]:
    """Links on a page that look like they lead to a careers page, best first."""
    parser = _LinkParser()
    parser.feed(page_html)
    base_host = urllib.parse.urlparse(base_url).netloc
    scored: dict[str, int] = {}
    for href, text in parser.links:
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        url = urllib.parse.urljoin(base_url, href).split("#")[0]
        score = 0
        if CAREER_LINK_RE.search(text):
            score += 2
        if CAREER_LINK_RE.search(urllib.parse.urlparse(url).path + urllib.parse.urlparse(url).netloc):
            score += 2
        if detect_boards(url):
            score += 5  # links straight to an ATS
        if score:
            host = urllib.parse.urlparse(url).netloc
            if host != base_host and not detect_boards(url) and not host.endswith("." + base_host.removeprefix("www.")):
                score -= 1  # some other site's careers link (e.g. a partner)
            scored[url] = max(scored.get(url, 0), score)
    return [u for u, _ in sorted(scored.items(), key=lambda kv: -kv[1])][:limit]


def detect_boards(page_html: str) -> list[Board]:
    found: dict[str, Board] = {}
    for ats, regex in ATS_PATTERNS:
        for m in regex.finditer(page_html):
            if ats == "workday":
                board = Board("workday", slug=m.group(2), host=m.group(1), site=m.group(3))
                if board.site in IGNORED_SLUGS or board.site == "wday":
                    continue
            else:
                slug = urllib.parse.unquote(m.group(1)).rstrip(".")
                if slug in IGNORED_SLUGS:
                    continue
                board = Board(ats, slug=slug)
            found.setdefault(board.label().lower(), board)
    return list(found.values())


def find_boards(site: str, fetch=fetch_html) -> tuple[list[Board], list[str], str]:
    """Return (boards, careers_pages_checked, careers_page_html_for_fallback)."""
    home_url, home_html = fetch(normalize_site(site))
    boards = detect_boards(home_html)
    pages = career_page_candidates(home_url, home_html)
    if not pages:
        pages = [urllib.parse.urljoin(home_url, p) for p in COMMON_CAREER_PATHS]
    checked: list[str] = []
    fallback_html = ""
    for page in pages:
        if boards:
            break
        if detect_boards(page):
            boards = detect_boards(page)
            checked.append(page)
            break
        try:
            final_url, html = fetch(page)
        except (urllib.error.URLError, TimeoutError, ValueError):
            continue
        checked.append(final_url)
        boards = detect_boards(final_url + "\n" + html)
        if not fallback_html and "JobPosting" in html:
            fallback_html = html
        if not boards:  # careers landing pages often link one level deeper ("See open roles")
            for deeper in career_page_candidates(final_url, html, limit=2):
                if deeper in pages or deeper in checked:
                    continue
                boards = detect_boards(deeper)
                if boards:
                    break
                try:
                    deeper_url, deeper_html = fetch(deeper)
                except (urllib.error.URLError, TimeoutError, ValueError):
                    continue
                checked.append(deeper_url)
                boards = detect_boards(deeper_url + "\n" + deeper_html)
                if not fallback_html and "JobPosting" in deeper_html:
                    fallback_html = deeper_html
                if boards:
                    break
    return boards, checked, fallback_html


# ---------------------------------------------------------------- reading jobs from a board


def jobs_from_board(board: Board, search_terms: list[str], get=http_get_json, post=None) -> list[Job]:
    if board.ats in ("greenhouse", "lever", "ashby"):
        fetcher = sources.SOURCES[board.ats]
        return fetcher({"companies": [board.slug]}, search_terms, get)
    if board.ats == "smartrecruiters":
        return fetch_smartrecruiters(board.slug, search_terms, get)
    if board.ats == "workday":
        return fetch_workday(board, search_terms, post or http_post_json)
    return []


def fetch_smartrecruiters(slug: str, terms: list[str], get=http_get_json) -> list[Job]:
    jobs: dict[str, Job] = {}
    for term in terms:
        url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?" + urllib.parse.urlencode({"q": term, "limit": 100})
        for r in (get(url, {}) or {}).get("content", []):
            loc = r.get("location") or {}
            detail_url = r.get("ref", "")
            description = ""
            if detail_url:  # the list endpoint has no description; the detail endpoint does
                try:
                    sections = ((get(detail_url, {}) or {}).get("jobAd") or {}).get("sections") or {}
                    description = html_to_text("\n".join((s or {}).get("text", "") for s in sections.values()))
                except (urllib.error.URLError, TimeoutError):
                    pass
            job = Job(
                source="smartrecruiters",
                title=r.get("name", ""),
                company=(r.get("company") or {}).get("name", slug),
                location=", ".join(x for x in (loc.get("city"), loc.get("region"), loc.get("country")) if x),
                url=f"https://jobs.smartrecruiters.com/{slug}/{r.get('id', '')}",
                description=description,
                posted=str(r.get("releasedDate", ""))[:10],
            )
            jobs.setdefault(job.key, job)
    return list(jobs.values())


def http_post_json(url: str, payload: dict, timeout: int = 30) -> object:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def fetch_workday(board: Board, terms: list[str], post=http_post_json, max_per_term: int = 60) -> list[Job]:
    """Workday career sites expose a JSON search API at /wday/cxs/<tenant>/<site>/."""
    api = f"https://{board.host}/wday/cxs/{board.slug}/{board.site}"
    public = f"https://{board.host}/{board.site}"
    jobs: dict[str, Job] = {}
    for term in terms:
        for offset in range(0, max_per_term, 20):
            data = post(f"{api}/jobs", {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": term}) or {}
            postings = data.get("jobPostings", [])
            for p in postings:
                path = p.get("externalPath", "")
                if not path or f"{public}{path}" in jobs:
                    continue
                description = ""
                try:
                    info = _workday_detail(api, path) or {}
                    description = html_to_text((info.get("jobPostingInfo") or {}).get("jobDescription", ""))
                except (urllib.error.URLError, TimeoutError, ValueError):
                    pass
                jobs[f"{public}{path}"] = Job(
                    source="workday",
                    title=p.get("title", ""),
                    company=board.slug,
                    location=p.get("locationsText", ""),
                    url=f"{public}{path}",
                    description=description,
                    posted=p.get("postedOn", ""),  # Workday gives relative text like "Posted 3 Days Ago"
                )
            if len(postings) < 20:
                break
    return list(jobs.values())


def _workday_detail(api: str, path: str):
    return http_get_json(f"{api}{path}", {"Accept": "application/json"})


# ---------------------------------------------------------------- schema.org fallback

_LD_JSON_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)


def jobs_from_jsonld(page_url: str, page_html: str, company_hint: str = "") -> list[Job]:
    """Read schema.org JobPosting objects embedded in a careers page."""
    jobs = []
    for block in _LD_JSON_RE.findall(page_html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for obj in _walk_jsonld(data):
            if obj.get("@type") != "JobPosting" and "JobPosting" not in (obj.get("@type") or []):
                continue
            org = obj.get("hiringOrganization") or {}
            loc = obj.get("jobLocation") or {}
            if isinstance(loc, list):
                loc = loc[0] if loc else {}
            addr = (loc.get("address") or {}) if isinstance(loc, dict) else {}
            if isinstance(addr, str):
                location = addr
            else:
                location = ", ".join(x for x in (addr.get("addressLocality"), addr.get("addressRegion")) if x)
            if obj.get("jobLocationType") == "TELECOMMUTE":
                location = (location + " (remote)").strip()
            jobs.append(Job(
                source="careers-page",
                title=html_to_text(obj.get("title", "")),
                company=(org.get("name") if isinstance(org, dict) else str(org)) or company_hint,
                location=location,
                url=obj.get("url") or page_url,
                description=html_to_text(obj.get("description", "")),
                posted=str(obj.get("datePosted", ""))[:10],
            ))
    return jobs


def _walk_jsonld(data):
    if isinstance(data, list):
        for item in data:
            yield from _walk_jsonld(item)
    elif isinstance(data, dict):
        yield data
        for key in ("@graph", "itemListElement", "item"):
            if key in data:
                yield from _walk_jsonld(data[key])


# ---------------------------------------------------------------- entry point


def jobs_from_company_site(site: str, search_terms: list[str], fetch=fetch_html) -> tuple[list[Job], str]:
    """Return (jobs, human-readable description of where they came from)."""
    boards, checked, fallback_html = find_boards(site, fetch)
    if boards:
        jobs: list[Job] = []
        for board in boards:
            try:
                jobs.extend(jobs_from_board(board, search_terms))
            except (urllib.error.URLError, TimeoutError, ValueError) as e:
                warn(f"  could not read {board.label()}: {e}")
        return jobs, "via " + ", ".join(b.label() for b in boards)
    if fallback_html:
        jobs = jobs_from_jsonld(checked[0] if checked else site, fallback_html,
                               urllib.parse.urlparse(normalize_site(site)).netloc)
        if jobs:
            return jobs, "via careers-page structured data"
    where = ", ".join(checked) or "homepage"
    return [], f"no job board found (checked {where}); open the careers page manually"
