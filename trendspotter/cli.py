"""Command-line entry point: python -m trendspotter [options]"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import smtplib
import sys
import tomllib
import urllib.error
from email.message import EmailMessage
from pathlib import Path

from .report import render_html, text_summary, write_csv
from .sources import SOURCES, ChartEntry, SourceSkipped, http_get_text, warn
from .trends import add_snapshot, find_trends

DEFAULT_CONFIG = Path("trendspotter.toml")
NET_ERRORS = (urllib.error.URLError, TimeoutError, ValueError, KeyError)


def load_config(path: Path) -> dict:
    if not path.exists():
        example = Path(__file__).resolve().parent.parent / "trendspotter.example.toml"
        warn(f"No {path} found - using {example.name}. Copy it to {path} to customize.")
        path = example
    with path.open("rb") as f:
        return tomllib.load(f)


def collect(cfg: dict, only: list[str] | None, get=None) -> list[ChartEntry]:
    entries: list[ChartEntry] = []
    for name in only or cfg.get("sources", list(SOURCES)):
        if name not in SOURCES:
            warn(f"[{name}] unknown source, skipping (known: {', '.join(SOURCES)})")
            continue
        try:
            found = SOURCES[name](cfg.get(name, {}), get or http_get_text)
            warn(f"[{name}] {len(found)} songs")
            entries.extend(found)
        except SourceSkipped as e:
            warn(f"[{name}] skipped: {e}")
        except NET_ERRORS as e:
            warn(f"[{name}] failed: {e}")
    return entries


def send_email(cfg: dict, subject: str, text: str, page: str) -> None:
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, cfg.get("from") or cfg["username"], cfg["to"]
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    with smtplib.SMTP_SSL(cfg.get("host", "smtp.gmail.com"), int(cfg.get("port", 465)), timeout=30) as s:
        s.login(cfg["username"], cfg["password"])
        s.send_message(msg)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="trendspotter", description="Find songs that are starting to trend.")
    p.add_argument("-c", "--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--out", type=Path, default=Path("trends"))
    p.add_argument("--top", type=int, default=15, help="how many songs to print / email")
    p.add_argument("--lookback", type=int, help="compare against the charts from this many days ago")
    p.add_argument("--source", action="append", dest="sources", help="only use this chart (repeatable)")
    p.add_argument("--no-email", action="store_true", help="don't send the email even if one is set up")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    today = dt.date.today()
    lookback = args.lookback or cfg.get("lookback_days", 3)
    min_score = cfg.get("min_score", 10)

    entries = collect(cfg, args.sources)
    if not entries:
        print("Couldn't get any charts. Check your internet connection and try again.")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    history_path = args.out / "history.json"
    history = json.loads(history_path.read_text()) if history_path.exists() else {}
    trends = [t for t in find_trends(entries, history, today, lookback) if t.score >= min_score]
    history_path.write_text(json.dumps(add_snapshot(history, today, entries)))

    seen_path = args.out / "reported.json"
    seen = set(json.loads(seen_path.read_text())) if seen_path.exists() else set()
    rows = [(t, t.key not in seen) for t in trends]
    seen_path.write_text(json.dumps(sorted(seen | {t.key for t in trends}), indent=0))

    days_of_history = len(history)
    run_info = f"{today:%b %d, %Y} · {len(entries)} chart spots checked · {days_of_history} earlier day{'' if days_of_history == 1 else 's'} of history"
    page = render_html(rows, run_info)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    html_path, csv_path = args.out / f"rising_{stamp}.html", args.out / f"rising_{stamp}.csv"
    html_path.write_text(page, encoding="utf-8")
    write_csv(csv_path, rows)

    new_count = sum(1 for _, is_new in rows if is_new)
    summary = text_summary(rows, args.top)
    print(f"\n{len(rows)} rising songs ({new_count} new since last report)\n")
    print(summary)
    if days_of_history < 3:
        print("\nTip: results get much better after a few days of runs, once there's chart history to compare.")
    print(f"\nFull report: {html_path}\nSpreadsheet: {csv_path}")

    email_cfg = cfg.get("email", {})
    if email_cfg.get("to") and email_cfg.get("password") and not args.no_email:
        try:
            send_email(email_cfg, f"Rising songs: {new_count} new · {today:%b %d}", summary, page)
            print(f"Emailed to {email_cfg['to']}")
        except (OSError, smtplib.SMTPException, KeyError) as e:
            warn(f"[email] couldn't send: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
