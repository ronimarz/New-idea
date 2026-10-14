"""Command-line entry point: python -m avjobs [options]"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import tomllib
import urllib.error
from pathlib import Path

from . import discover
from .report import write_csv, write_html
from .scoring import Scorer
from .sources import SOURCES, Job, SourceSkipped, warn

DEFAULT_CONFIG = Path("config.toml")


def load_config(path: Path) -> dict:
    if not path.exists():
        example = Path(__file__).resolve().parent.parent / "config.example.toml"
        warn(f"No {path} found - using {example.name}. Copy it to {path} to customize.")
        path = example
    with path.open("rb") as f:
        return tomllib.load(f)


def collect(cfg: dict, scorer: Scorer, only: list[str] | None, sites: list[str]) -> list[Job]:
    jobs: list[Job] = []
    enabled = only or cfg.get("sources", {}).get("enabled", list(SOURCES))
    for name in enabled:
        if name == "company_sites":
            continue
        if name not in SOURCES:
            warn(f"[{name}] unknown source, skipping (known: {', '.join(SOURCES)})")
            continue
        try:
            found = SOURCES[name](cfg.get(name, {}), scorer.search_terms)
            warn(f"[{name}] {len(found)} postings")
            jobs.extend(found)
        except SourceSkipped as e:
            warn(f"[{name}] skipped: {e}")
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            warn(f"[{name}] failed: {e}")

    if not only or "company_sites" in only:
        sites = sites or cfg.get("company_sites", {}).get("sites", [])
    for site in sites:
        try:
            found, how = discover.jobs_from_company_site(site, scorer.search_terms)
            warn(f"[site] {site}: {len(found)} postings {how}")
            jobs.extend(found)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            warn(f"[site] {site}: failed: {e}")
    return jobs


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="avjobs", description="Find job postings whose duties include AV work.")
    p.add_argument("-c", "--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--profile", help="keyword profile: audiovisual (default) or autonomous")
    p.add_argument("--min-score", type=float, help="hide postings scoring below this")
    p.add_argument("--source", action="append", dest="sources", help="only use this source (repeatable)")
    p.add_argument("--site", action="append", default=[], help="company website to search directly (repeatable)")
    p.add_argument("--find-board", metavar="SITE", help="just show which careers page / job board a company uses")
    p.add_argument("--out", type=Path, default=Path("reports"))
    p.add_argument("--top", type=int, default=15, help="how many results to print in the terminal")
    args = p.parse_args(argv)

    if args.find_board:
        boards, checked, _ = discover.find_boards(args.find_board)
        for page in checked:
            print(f"checked  {page}")
        for b in boards:
            print(f"found    {b.label()}")
        if not boards:
            print("no known job board detected")
        return 0

    cfg = load_config(args.config)
    profile = args.profile or cfg.get("profile", "audiovisual")
    min_score = args.min_score if args.min_score is not None else cfg.get("min_score", 6)
    scorer = Scorer(profile, cfg.get("extra_terms", []))

    jobs = collect(cfg, scorer, args.sources, args.site)
    unique: dict[str, Job] = {}
    for job in jobs:
        unique.setdefault(job.key, job)

    loc_filters = [s.lower() for s in cfg.get("location_include", [])]
    results = []
    for job in unique.values():
        if loc_filters and not any(f in job.location.lower() for f in loc_filters):
            continue
        score = scorer.score(job.title, job.description)
        if score.total >= min_score:
            results.append((job, score))
    results.sort(key=lambda r: -r[1].total)

    args.out.mkdir(parents=True, exist_ok=True)
    seen_path = args.out / "seen.json"
    seen = set(json.loads(seen_path.read_text())) if seen_path.exists() else set()
    rows = [(job, score, job.key not in seen) for job, score in results]
    seen_path.write_text(json.dumps(sorted(seen | {job.key for job, _ in results}), indent=0))

    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    html_path, csv_path = args.out / f"av-jobs_{stamp}.html", args.out / f"av-jobs_{stamp}.csv"
    run_info = f"{dt.date.today():%b %d, %Y} · profile '{profile}' · {len(unique)} postings scanned · min score {min_score:g}"
    write_html(html_path, rows, scorer.highlight_regexes(), "AV job matches", run_info)
    write_csv(csv_path, rows)

    new_count = sum(1 for *_, is_new in rows if is_new)
    print(f"\n{len(rows)} AV-related postings ({new_count} new) out of {len(unique)} scanned\n")
    for job, score, is_new in rows[: args.top]:
        flag = "NEW " if is_new else "    "
        print(f"{flag}{score.total:5.1f}  {job.title[:60]:<60}  {job.company[:25]:<25}  {job.location[:30]}")
        if score.tags:
            print(f"             {', '.join(score.tags[:4])}")
    print(f"\nFull report: {html_path}\nSpreadsheet: {csv_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
