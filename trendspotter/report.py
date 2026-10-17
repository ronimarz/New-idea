"""Write the rising songs as an HTML page (open on your phone, or arrives by email) and a CSV."""

from __future__ import annotations

import csv
import html
import urllib.parse
from pathlib import Path

from .trends import Trend

SOURCE_NAMES = {"apple": "Apple Music", "spotify": "Spotify", "lastfm": "Last.fm"}
CSV_FIELDS = ["new", "score", "artist", "title", "best_rank", "charts", "notes", "first_seen", "tiktok"]


def links(t: Trend) -> dict[str, str]:
    q = f"{t.artist} {t.title}"
    return {
        "TikTok": "https://www.tiktok.com/search?q=" + urllib.parse.quote(q),
        "Spotify": "https://open.spotify.com/search/" + urllib.parse.quote(q),
        "YouTube": "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(q),
    }


def climb_label(c) -> str:
    name = SOURCE_NAMES.get(c.source, c.source)
    return f"{name} #{c.rank} " + ("NEW" if c.new else f"▲{c.places}" if c.places > 0 else f"▼{-c.places}" if c.places else "=")


def write_csv(path: Path, rows: list[tuple[Trend, bool]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for t, is_new in rows:
            w.writerow({
                "new": "yes" if is_new else "",
                "score": t.score,
                "artist": t.artist,
                "title": t.title,
                "best_rank": t.best_rank,
                "charts": "; ".join(climb_label(c) for c in t.climbs),
                "notes": "; ".join(t.notes),
                "first_seen": t.first_seen,
                "tiktok": links(t)["TikTok"],
            })


def text_summary(rows: list[tuple[Trend, bool]], top: int) -> str:
    lines = []
    for t, is_new in rows[:top]:
        flag = "NEW " if is_new else "    "
        lines.append(f"{flag}{t.score:5.0f}  {t.artist} - {t.title}")
        lines.append(f"            {' · '.join(climb_label(c) for c in t.climbs)}{'  (' + ', '.join(t.notes) + ')' if t.notes else ''}")
    return "\n".join(lines)


def render_html(rows: list[tuple[Trend, bool]], run_info: str) -> str:
    cards = []
    for t, is_new in rows:
        chips = "".join(f'<span class="chip{" up" if c.places > 0 else ""}">{html.escape(climb_label(c))}</span>' for c in t.climbs)
        notes = f'<p class="notes">{html.escape(" · ".join(t.notes))}</p>' if t.notes else ""
        link_html = " · ".join(f'<a href="{html.escape(u)}" target="_blank" rel="noopener">{n}</a>' for n, u in links(t).items())
        cards.append(f"""
<article class="song" data-new="{int(is_new)}" data-search="{html.escape((t.artist + ' ' + t.title).lower())}">
  <div class="score" title="Trend score">{t.score:.0f}</div>
  <div class="body">
    <h2>{html.escape(t.title)}{' <span class="new">NEW</span>' if is_new else ''}</h2>
    <p class="artist">{html.escape(t.artist)}</p>
    <div class="chips">{chips}</div>
    {notes}
    <p class="links">{link_html}</p>
  </div>
</article>""")
    return TEMPLATE.replace("{{RUN_INFO}}", html.escape(run_info)) \
        .replace("{{COUNT}}", str(len(rows))) \
        .replace("{{CARDS}}", "\n".join(cards) or "<p class='empty'>Nothing rising yet. The first few runs build up chart history; check back tomorrow.</p>")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rising songs</title>
<style>
:root{--bg:#f6f6f9;--card:#fff;--ink:#1b1b22;--muted:#62626e;--line:#e3e3ea;--accent:#7c3aed;--up:#15803d;--chip:#f0eefc}
@media (prefers-color-scheme:dark){:root{--bg:#131317;--card:#1d1d23;--ink:#ececf1;--muted:#a0a0ad;--line:#2e2e37;--accent:#a78bfa;--up:#4ade80;--chip:#26233a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;z-index:1}
h1{font-size:18px;margin:0 0 4px}.run{color:var(--muted);font-size:13px;margin:0 0 10px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-size:13px;color:var(--muted)}main{max-width:820px;margin:0 auto;padding:12px 16px 40px}
.song{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.score{flex:0 0 52px;height:52px;border-radius:10px;background:var(--chip);display:grid;place-items:center;font-weight:700;font-size:18px;color:var(--accent)}
.body{min-width:0;flex:1}h2{font-size:16px;margin:0;overflow-wrap:anywhere}.artist{margin:0 0 6px;color:var(--muted)}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 9px;font-size:12px;margin:0 4px 4px 0}.chip.up{color:var(--up);font-weight:600}
.notes{font-size:13px;color:var(--muted);margin:2px 0}.links{font-size:13px;margin:4px 0 0}.links a{color:var(--accent)}
.new{background:var(--accent);color:var(--card);font-size:11px;border-radius:4px;padding:1px 6px;vertical-align:middle}
.empty{color:var(--muted)}
</style></head><body>
<header><h1>Rising songs</h1><p class="run">{{RUN_INFO}} · <span id="shown">{{COUNT}}</span> of {{COUNT}} shown</p>
<div class="controls"><input type="search" id="q" placeholder="Filter by artist or song">
<label><input type="checkbox" id="onlyNew"> new only</label></div></header>
<main id="list">{{CARDS}}</main>
<script>
const q=document.getElementById('q'),n=document.getElementById('onlyNew'),shown=document.getElementById('shown');
function apply(){const t=q.value.toLowerCase().split(/\\s+/).filter(Boolean);let c=0;
for(const el of document.querySelectorAll('.song')){const ok=t.every(w=>el.dataset.search.includes(w))&&(!n.checked||el.dataset.new==='1');
el.style.display=ok?'':'none';if(ok)c++}shown.textContent=c}
[q,n].forEach(e=>e.addEventListener('input',apply));
</script></body></html>
"""
