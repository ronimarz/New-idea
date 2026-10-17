"""Write deals as an HTML page you can open on your phone, and a CSV."""

from __future__ import annotations

import csv
import html
from pathlib import Path

from .deals import Deal
from .web import ebay_sold_url

CSV_FIELDS = ["new", "profit", "price", "resale", "item", "title", "location", "source", "warning", "url"]


def write_csv(path: Path, rows: list[tuple[Deal, bool]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for d, is_new in rows:
            w.writerow({
                "new": "yes" if is_new else "",
                "profit": d.profit,
                "price": d.listing.price,
                "resale": d.item.resale,
                "item": d.item.name,
                "title": d.listing.title,
                "location": d.listing.location,
                "source": d.listing.source,
                "warning": "price unusually low" if d.suspicious else "",
                "url": d.listing.url,
            })


def write_html(path: Path, rows: list[tuple[Deal, bool]], run_info: str) -> None:
    cards = []
    for d, is_new in rows:
        l = d.listing
        warn = '<p class="warn">Unusually cheap. Check that it works, and meet in a public place.</p>' if d.suspicious else ""
        cards.append(f"""
<article class="deal" data-new="{int(is_new)}" data-search="{html.escape((l.title + ' ' + d.item.name + ' ' + l.location).lower())}">
  <div class="profit"><b>+${d.profit:,.0f}</b><span>profit</span></div>
  <div class="body">
    <h2><a href="{html.escape(l.url)}" target="_blank" rel="noopener">{html.escape(l.title)}</a>{' <span class="new">NEW</span>' if is_new else ''}</h2>
    <p class="meta">Asking <b>${l.price:,.0f}</b> · resells ~${d.item.resale:,.0f} · {html.escape(d.item.name)}{' · ' + html.escape(l.location) if l.location else ''}
      · <a href="{html.escape(ebay_sold_url(d.item.search))}" target="_blank" rel="noopener">check sold prices</a></p>
    {warn}
  </div>
</article>""")
    page = TEMPLATE.replace("{{RUN_INFO}}", html.escape(run_info)) \
        .replace("{{COUNT}}", str(len(rows))) \
        .replace("{{CARDS}}", "\n".join(cards) or "<p class='empty'>No deals this run. Try again later, or add more items to your watchlist.</p>")
    path.write_text(page, encoding="utf-8")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flip deals</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5d6672;--line:#e2e5ea;--accent:#1f8a4c;--tag:#e8f5ec;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--ink:#e8eaed;--muted:#9aa3ae;--line:#2c3138;--accent:#5fd08f;--tag:#1d2a22;--warn:#f0b35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;z-index:1}
h1{font-size:18px;margin:0 0 4px}.run{color:var(--muted);font-size:13px;margin:0 0 10px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-size:13px;color:var(--muted)}main{max-width:900px;margin:0 auto;padding:12px 16px 40px}
.deal{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.profit{flex:0 0 72px;border-radius:8px;background:var(--tag);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--accent);padding:6px}
.profit b{font-size:17px}.profit span{font-size:11px;color:var(--muted)}
.body{min-width:0;flex:1}h2{font-size:16px;margin:0;overflow-wrap:anywhere}h2 a{color:var(--ink);text-decoration:none}h2 a:hover{color:var(--accent);text-decoration:underline}
.meta{color:var(--muted);font-size:13px;margin:2px 0 0}.meta a{color:var(--accent)}.warn{color:var(--warn);font-size:13px;margin:4px 0 0}
.new{background:var(--accent);color:var(--card);font-size:11px;border-radius:4px;padding:1px 6px;vertical-align:middle}
.empty{color:var(--muted)}
</style></head><body>
<header><h1>Flip deals</h1><p class="run">{{RUN_INFO}} · <span id="shown">{{COUNT}}</span> of {{COUNT}} shown</p>
<div class="controls"><input type="search" id="q" placeholder="Filter (e.g. dewalt, chair)">
<label><input type="checkbox" id="onlyNew"> new only</label></div></header>
<main id="list">{{CARDS}}</main>
<script>
const q=document.getElementById('q'),n=document.getElementById('onlyNew'),shown=document.getElementById('shown');
function apply(){const t=q.value.toLowerCase().split(/\\s+/).filter(Boolean);let c=0;
for(const el of document.querySelectorAll('.deal')){const ok=t.every(w=>el.dataset.search.includes(w))&&(!n.checked||el.dataset.new==='1');
el.style.display=ok?'':'none';if(ok)c++}shown.textContent=c}
[q,n].forEach(e=>e.addEventListener('input',apply));
</script></body></html>
"""
