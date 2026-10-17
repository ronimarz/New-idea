"""Command-line entry point: python -m gapfinder [options]"""

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
from .signals import detect, group_hits
from .sources import SOURCES, Post, http_get_text, warn

DEFAULT_CONFIG = Path("gapfinder.toml")
NET_ERRORS = (urllib.error.URLError, TimeoutError, ValueError, KeyError)


def load_config(path: Path) -> dict:
    if not path.exists():
        example = Path(__file__).resolve().parent.parent / "gapfinder.example.toml"
        warn(f"No {path} found - using {example.name}. Copy it to {path} to customize.")
        path = example
    with path.open("rb") as f:
        return tomllib.load(f)


def collect(cfg: dict, only: list[str] | None, since: dt.date, get=None) -> list[Post]:
    posts: list[Post] = []
    for name in only or cfg.get("sources", list(SOURCES)):
        if name not in SOURCES:
            warn(f"[{name}] unknown source, skipping (known: {', '.join(SOURCES)})")
            continue
        try:
            found = SOURCES[name](cfg.get(name, {}), since, get or http_get_text)
            warn(f"[{name}] {len(found)} posts")
            posts.extend(found)
        except NET_ERRORS as e:
            warn(f"[{name}] failed: {e}")
    return posts


def send_email(cfg: dict, subject: str, text: str, page: str) -> None:
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, cfg.get("from") or cfg["username"], cfg["to"]
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    with smtplib.SMTP_SSL(cfg.get("host", "smtp.gmail.com"), int(cfg.get("port", 465)), timeout=30) as s:
        s.login(cfg["username"], cfg["password"])
        s.send_message(msg)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="gapfinder", description="Find things people keep asking for.")
    p.add_argument("-c", "--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--out", type=Path, default=Path("gaps"))
    p.add_argument("--days", type=int, help="look at posts from this many days back")
    p.add_argument("--focus", action="append", help="only keep posts mentioning this word (repeatable)")
    p.add_argument("--source", action="append", dest="sources", help="only use this source (repeatable)")
    p.add_argument("--top", type=int, default=15, help="how many to print / email")
    p.add_argument("--no-email", action="store_true", help="don't send the email even if one is set up")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    days = args.days or cfg.get("days", 30)
    focus = args.focus or cfg.get("focus_words", [])
    since = dt.date.today() - dt.timedelta(days=days)

    posts = collect(cfg, args.sources, since)
    if not posts:
        print("Couldn't get any posts. Check your internet connection and try again.")
        return 1
    unique = list({p.url: p for p in posts}.values())
    hits = [h for h in (detect(p, focus) for p in unique) if h]
    groups = [g for g in group_hits(hits) if g.score >= cfg.get("min_score", 2)]

    args.out.mkdir(parents=True, exist_ok=True)
    seen_path = args.out / "seen.json"
    seen = set(json.loads(seen_path.read_text())) if seen_path.exists() else set()
    rows = [(g, any(h.post.url not in seen for h in g.hits)) for g in groups]
    seen_path.write_text(json.dumps(sorted(seen | {h.post.url for h in hits}), indent=0))

    repeated = sum(1 for g in groups if len(g.hits) > 1)
    run_info = (f"{dt.date.today():%b %d, %Y} · last {days} days · {len(unique)} posts read · "
                f"{len(hits)} requests · {repeated} asked more than once" + (f" · focus: {', '.join(focus)}" if focus else ""))
    page = render_html(rows, run_info)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    html_path, csv_path = args.out / f"gaps_{stamp}.html", args.out / f"gaps_{stamp}.csv"
    html_path.write_text(page, encoding="utf-8")
    write_csv(csv_path, rows)

    new_count = sum(1 for _, is_new in rows if is_new)
    summary = text_summary(rows, args.top)
    print(f"\n{len(groups)} unmet need{'' if len(groups) == 1 else 's'} from {len(hits)} requests ({repeated} asked more than once, {new_count} with new posts)\n")
    print(summary)
    print(f"\nFull report: {html_path}\nSpreadsheet: {csv_path}")

    email_cfg = cfg.get("email", {})
    if email_cfg.get("to") and email_cfg.get("password") and not args.no_email:
        try:
            send_email(email_cfg, f"Unmet needs: {repeated} repeated asks · {dt.date.today():%b %d}", summary, page)
            print(f"Emailed to {email_cfg['to']}")
        except (OSError, smtplib.SMTPException, KeyError) as e:
            warn(f"[email] couldn't send: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
