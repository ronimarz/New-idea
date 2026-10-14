"""Fetch job postings from public job APIs and normalize them into Job records.

Sources that need no key:      remotive, greenhouse, lever, ashby
Sources that need a free key:  adzuna (developer.adzuna.com), usajobs (developer.usajobs.gov)
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .scoring import html_to_text

USER_AGENT = "avjobs/0.1 (job search helper)"


@dataclass
class Job:
    source: str
    title: str
    company: str
    location: str
    url: str
    description: str
    posted: str = ""  # ISO date (YYYY-MM-DD) when known
    salary: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return self.url or f"{self.source}:{self.company}:{self.title}:{self.location}"


Fetcher = Callable[[str, dict], object]


def http_get_json(url: str, headers: dict | None = None, timeout: int = 30) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _iso(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, (int, float)):  # Lever uses epoch milliseconds
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).date().isoformat()
    return str(value)[:10]


def _salary(lo, hi, unit: str = "") -> str:
    if not lo and not hi:
        return ""
    fmt = lambda v: f"${float(v):,.0f}" if v else "?"
    return f"{fmt(lo)}–{fmt(hi)}{(' ' + unit) if unit else ''}"


# ---------------------------------------------------------------- keyword search sources


def fetch_adzuna(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    app_id, app_key = cfg.get("app_id"), cfg.get("app_key")
    if not (app_id and app_key):
        raise SourceSkipped("set [adzuna] app_id and app_key (free at developer.adzuna.com)")
    country = cfg.get("country", "us")
    jobs: list[Job] = []
    for page in range(1, int(cfg.get("pages", 2)) + 1):
        params = {
            "app_id": app_id,
            "app_key": app_key,
            "results_per_page": 50,
            "what_or": " ".join(_single_words(terms)),
            "max_days_old": cfg.get("max_days_old", 30),
            "content-type": "application/json",
        }
        if cfg.get("where"):
            params["where"] = cfg["where"]
            params["distance"] = cfg.get("distance_km", 50)
        url = f"https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?" + urllib.parse.urlencode(params)
        data = get(url, {})
        results = data.get("results", [])
        for r in results:
            jobs.append(Job(
                source="adzuna",
                title=r.get("title", ""),
                company=(r.get("company") or {}).get("display_name", ""),
                location=(r.get("location") or {}).get("display_name", ""),
                url=r.get("redirect_url", ""),
                description=html_to_text(r.get("description", "")),
                posted=_iso(r.get("created")),
                salary=_salary(r.get("salary_min"), r.get("salary_max")),
            ))
        if len(results) < 50:
            break
    return jobs


def _single_words(terms: Iterable[str]) -> list[str]:
    """Adzuna's what_or takes space-separated single words."""
    words: list[str] = []
    for term in terms:
        for word in term.replace("-", " ").split():
            if len(word) > 2 and word.lower() not in {"and", "the", "technician", "integration"} \
                    and word.lower() not in (w.lower() for w in words):
                words.append(word)
    return words


def fetch_usajobs(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    api_key, email = cfg.get("api_key"), cfg.get("email")
    if not (api_key and email):
        raise SourceSkipped("set [usajobs] api_key and email (free at developer.usajobs.gov)")
    headers = {"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": api_key}
    jobs: dict[str, Job] = {}
    for term in terms:
        params = {"Keyword": term, "ResultsPerPage": 250, "DatePosted": cfg.get("max_days_old", 30)}
        if cfg.get("where"):
            params["LocationName"] = cfg["where"]
        data = get("https://data.usajobs.gov/api/search?" + urllib.parse.urlencode(params), headers)
        for item in (data.get("SearchResult") or {}).get("SearchResultItems", []):
            d = item.get("MatchedObjectDescriptor", {})
            details = (d.get("UserArea") or {}).get("Details") or {}
            duties = details.get("MajorDuties") or []
            if isinstance(duties, str):
                duties = [duties]
            desc = "\n".join([details.get("JobSummary", ""), *duties, d.get("QualificationSummary", "")])
            pay = (d.get("PositionRemuneration") or [{}])[0]
            job = Job(
                source="usajobs",
                title=d.get("PositionTitle", ""),
                company=d.get("OrganizationName", ""),
                location=d.get("PositionLocationDisplay", ""),
                url=d.get("PositionURI", ""),
                description=html_to_text(desc),
                posted=_iso(d.get("PublicationStartDate")),
                salary=_salary(pay.get("MinimumRange"), pay.get("MaximumRange"), pay.get("Description", "")),
            )
            jobs.setdefault(job.key, job)
    return list(jobs.values())


def fetch_remotive(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    jobs: dict[str, Job] = {}
    for term in terms:
        url = "https://remotive.com/api/remote-jobs?" + urllib.parse.urlencode({"search": term, "limit": 100})
        for r in get(url, {}).get("jobs", []):
            job = Job(
                source="remotive",
                title=r.get("title", ""),
                company=r.get("company_name", ""),
                location=r.get("candidate_required_location") or "Remote",
                url=r.get("url", ""),
                description=html_to_text(r.get("description", "")),
                posted=_iso(r.get("publication_date")),
                salary=r.get("salary", "") or "",
            )
            jobs.setdefault(job.key, job)
    return list(jobs.values())


# ---------------------------------------------------------------- company career boards
# These return every open role at a company; scoring then keeps only the AV ones.


def fetch_greenhouse(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    jobs = []
    for slug in cfg.get("companies", []):
        data = _company_board(get, f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true", slug)
        for r in (data or {}).get("jobs", []):
            jobs.append(Job(
                source="greenhouse",
                title=r.get("title", ""),
                company=r.get("company_name") or slug,
                location=(r.get("location") or {}).get("name", ""),
                url=r.get("absolute_url", ""),
                description=html_to_text(r.get("content", "")),
                posted=_iso(r.get("first_published") or r.get("updated_at")),
            ))
    return jobs


def fetch_lever(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    jobs = []
    for slug in cfg.get("companies", []):
        data = _company_board(get, f"https://api.lever.co/v0/postings/{slug}?mode=json", slug)
        for r in data or []:
            sections = [html_to_text(s.get("text", "") + "\n" + s.get("content", "")) for s in r.get("lists", [])]
            desc = "\n".join([r.get("descriptionPlain", ""), *sections, r.get("additionalPlain", "")])
            cats = r.get("categories") or {}
            salary = r.get("salaryRange") or {}
            jobs.append(Job(
                source="lever",
                title=r.get("text", ""),
                company=slug,
                location=cats.get("location", ""),
                url=r.get("hostedUrl", ""),
                description=desc.strip(),
                posted=_iso(r.get("createdAt")),
                salary=_salary(salary.get("min"), salary.get("max"), salary.get("interval", "")),
            ))
    return jobs


def fetch_ashby(cfg: dict, terms: list[str], get: Fetcher = http_get_json) -> list[Job]:
    jobs = []
    for slug in cfg.get("companies", []):
        data = _company_board(get, f"https://api.ashbyhq.com/posting-api/job-board/{slug}", slug)
        for r in (data or {}).get("jobs", []):
            jobs.append(Job(
                source="ashby",
                title=r.get("title", ""),
                company=slug,
                location=r.get("location", "") + (" (remote ok)" if r.get("isRemote") else ""),
                url=r.get("jobUrl", ""),
                description=r.get("descriptionPlain") or html_to_text(r.get("descriptionHtml", "")),
                posted=_iso(r.get("publishedAt")),
            ))
    return jobs


def _company_board(get: Fetcher, url: str, slug: str):
    try:
        return get(url, {})
    except urllib.error.HTTPError as e:
        if e.code == 404:
            warn(f"  board '{slug}' not found (check the company slug in its careers URL)")
            return None
        raise


class SourceSkipped(Exception):
    """Raised when a source is enabled but not configured."""


SOURCES = {
    "adzuna": fetch_adzuna,
    "usajobs": fetch_usajobs,
    "remotive": fetch_remotive,
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
}


def warn(msg: str) -> None:
    print(msg, file=sys.stderr)
