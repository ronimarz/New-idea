"""Write the groups of requests as an HTML page (open on your phone, or arrives by email) and a CSV."""

from __future__ import annotations

import csv
import html
from pathlib import Path

from .signals import Group

CSV_FIELDS = ["new", "score", "requests", "headline", "keywords", "signals", "communities", "example_quote", "link"]
SHOW_PER_GROUP = 5


def signal_summary(g: Group) -> list[str]:
    counts: dict[str, int] = {}
    for h in g.hits:
        for label in h.labels:
            counts[label] = counts.get(label, 0) + 1
    return [f"{label} ×{n}" if n > 1 else label for label, n in sorted(counts.items(), key=lambda kv: -kv[1])]


def write_csv(path: Path, rows: list[tuple[Group, bool]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for g, is_new in rows:
            top = g.headline
            w.writerow({
                "new": "yes" if is_new else "",
                "score": g.score,
                "requests": len(g.hits),
                "headline": top.post.title,
                "keywords": ", ".join(g.keywords),
                "signals": "; ".join(signal_summary(g)),
                "communities": "; ".join(g.communities),
                "example_quote": top.quote,
                "link": top.post.url,
            })


def text_summary(rows: list[tuple[Group, bool]], top: int) -> str:
    lines = []
    for g, is_new in rows[:top]:
        flag = "NEW " if is_new else "    "
        n = len(g.hits)
        lines.append(f"{flag}{g.score:5.0f}  {g.headline.post.title[:80]}")
        lines.append(f"            {n} request{'s' if n > 1 else ''} · {', '.join(g.communities)[:60]} · {', '.join(signal_summary(g)[:3])}")
        lines.append(f"            {g.headline.post.url}")
    return "\n".join(lines)


def render_html(rows: list[tuple[Group, bool]], run_info: str) -> str:
    cards = []
    for g, is_new in rows:
        top, n = g.headline, len(g.hits)
        chips = "".join(f'<span class="chip sig">{html.escape(s)}</span>' for s in signal_summary(g))
        chips += "".join(f'<span class="chip">{html.escape(c)}</span>' for c in g.communities)
        quotes = "".join(
            f'<li><q>{html.escape(h.quote)}</q> <a href="{html.escape(h.post.url)}" target="_blank" rel="noopener">'
            f'{html.escape(h.post.community)}, {h.post.created:%b %d}</a></li>'
            for h in sorted(g.hits, key=lambda h: -h.strength)[:SHOW_PER_GROUP])
        more = f'<p class="more">+{n - SHOW_PER_GROUP} more in the spreadsheet</p>' if n > SHOW_PER_GROUP else ""
        keywords = f'<p class="kw">About: {html.escape(", ".join(g.keywords))}</p>' if g.keywords else ""
        search = html.escape(" ".join([top.post.title, *g.keywords, *g.communities]).lower())
        cards.append(f"""
<article class="gap" data-new="{int(is_new)}" data-count="{n}" data-search="{search}">
  <div class="count"><b>{n}</b><span>{'requests' if n > 1 else 'request'}</span></div>
  <div class="body">
    <h2><a href="{html.escape(top.post.url)}" target="_blank" rel="noopener">{html.escape(top.post.title or top.quote[:120])}</a>{' <span class="new">NEW</span>' if is_new else ''}</h2>
    {keywords}
    <div class="chips">{chips}</div>
    <ul class="quotes">{quotes}</ul>{more}
  </div>
</article>""")
    return TEMPLATE.replace("{{RUN_INFO}}", html.escape(run_info)) \
        .replace("{{COUNT}}", str(len(rows))) \
        .replace("{{CARDS}}", "\n".join(cards) or "<p class='empty'>No requests found this run. Try more communities or a longer time window.</p>")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unmet needs</title>
<style>
:root{--bg:#f6f7f8;--card:#fff;--ink:#1a1d21;--muted:#5f6670;--line:#e1e4e8;--accent:#0f766e;--chip:#e9f3f2;--sig:#fdf0e1;--sigink:#9a4a00}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--card:#1b1e21;--ink:#e9ecef;--muted:#9aa3ad;--line:#2c3136;--accent:#2dd4bf;--chip:#1c2b2a;--sig:#33261a;--sigink:#f5b971}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;z-index:1}
h1{font-size:18px;margin:0 0 4px}.run{color:var(--muted);font-size:13px;margin:0 0 10px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-size:13px;color:var(--muted)}main{max-width:860px;margin:0 auto;padding:12px 16px 40px}
.gap{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.count{flex:0 0 64px;height:58px;border-radius:10px;background:var(--chip);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--accent)}
.count b{font-size:20px;line-height:1}.count span{font-size:11px;color:var(--muted)}
.body{min-width:0;flex:1}h2{font-size:16px;margin:0 0 2px;overflow-wrap:anywhere}h2 a{color:var(--ink);text-decoration:none}h2 a:hover{color:var(--accent);text-decoration:underline}
.kw{font-size:13px;color:var(--muted);margin:0 0 6px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 9px;font-size:12px;margin:0 4px 4px 0}.chip.sig{background:var(--sig);color:var(--sigink);font-weight:600}
.quotes{margin:6px 0 0;padding-left:18px;font-size:14px}.quotes li{margin:4px 0;overflow-wrap:anywhere}.quotes a{color:var(--muted);font-size:12px}
.more{font-size:12px;color:var(--muted);margin:4px 0 0}
.new{background:var(--accent);color:var(--card);font-size:11px;border-radius:4px;padding:1px 6px;vertical-align:middle}
.empty{color:var(--muted)}
</style></head><body>
<header><h1>Unmet needs</h1><p class="run">{{RUN_INFO}} · <span id="shown">{{COUNT}}</span> of {{COUNT}} shown</p>
<div class="controls"><input type="search" id="q" placeholder="Filter (e.g. music, invoice, r/smallbusiness)">
<label><input type="checkbox" id="onlyNew"> new only</label>
<label><input type="checkbox" id="multi"> asked 2+ times</label></div></header>
<main id="list">{{CARDS}}</main>
<script>
const q=document.getElementById('q'),n=document.getElementById('onlyNew'),m=document.getElementById('multi'),shown=document.getElementById('shown');
function apply(){const t=q.value.toLowerCase().split(/\\s+/).filter(Boolean);let c=0;
for(const el of document.querySelectorAll('.gap')){const ok=t.every(w=>el.dataset.search.includes(w))&&(!n.checked||el.dataset.new==='1')&&(!m.checked||+el.dataset.count>1);
el.style.display=ok?'':'none';if(ok)c++}shown.textContent=c}
[q,n,m].forEach(e=>e.addEventListener('input',apply));
</script></body></html>
"""
