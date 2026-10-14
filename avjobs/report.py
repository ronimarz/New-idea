"""Write results as a searchable HTML page and a CSV."""

from __future__ import annotations

import csv
import html
import json
import re
from pathlib import Path

from .scoring import Score
from .sources import Job

CSV_FIELDS = ["new", "score", "title", "company", "location", "posted", "salary", "tags", "matched_terms", "source", "url"]


def write_csv(path: Path, rows: list[tuple[Job, Score, bool]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for job, score, is_new in rows:
            w.writerow({
                "new": "yes" if is_new else "",
                "score": score.total,
                "title": job.title,
                "company": job.company,
                "location": job.location,
                "posted": job.posted,
                "salary": job.salary,
                "tags": "; ".join(score.tags),
                "matched_terms": "; ".join(score.matched_terms),
                "source": job.source,
                "url": job.url,
            })


def _highlight(text: str, regexes: list[re.Pattern]) -> str:
    spans = sorted({m.span() for r in regexes for m in r.finditer(text)})
    out, pos = [], 0
    for start, end in spans:
        if start < pos:
            continue
        out.append(html.escape(text[pos:start]))
        out.append(f"<mark>{html.escape(text[start:end])}</mark>")
        pos = end
    out.append(html.escape(text[pos:]))
    return "".join(out)


def write_html(path: Path, rows: list[tuple[Job, Score, bool]], regexes: list[re.Pattern], title: str, run_info: str) -> None:
    cards = []
    for job, score, is_new in rows:
        snippets = "".join(f"<li>{_highlight(s, regexes)}</li>" for s in score.snippets)
        tags = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in score.tags)
        meta = " · ".join(html.escape(x) for x in (job.company, job.location, job.posted, job.salary) if x)
        search_blob = html.escape(" ".join([job.title, job.company, job.location, *score.tags, *score.matched_terms]).lower())
        cards.append(f"""
<article class="job" data-score="{score.total}" data-new="{int(is_new)}" data-search="{search_blob}">
  <div class="score" title="AV relevance score">{score.total:g}</div>
  <div class="body">
    <h2><a href="{html.escape(job.url)}" target="_blank" rel="noopener">{html.escape(job.title)}</a>{' <span class="new">NEW</span>' if is_new else ''}</h2>
    <p class="meta">{meta} <span class="src">{html.escape(job.source)}</span></p>
    <div class="tags">{tags}</div>
    <ul class="snippets">{snippets}</ul>
  </div>
</article>""")
    page = TEMPLATE.replace("{{TITLE}}", html.escape(title)) \
        .replace("{{RUN_INFO}}", html.escape(run_info)) \
        .replace("{{COUNT}}", str(len(rows))) \
        .replace("{{CARDS}}", "\n".join(cards) or "<p class='empty'>No matching jobs this run.</p>")
    path.write_text(page, encoding="utf-8")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5d6672;--line:#e2e5ea;--accent:#2457d6;--mark:#ffe58a;--tag:#eef2fb}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--ink:#e8eaed;--muted:#9aa3ae;--line:#2c3138;--accent:#7aa2ff;--mark:#6b5a12;--tag:#232a38}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;z-index:1}
h1{font-size:18px;margin:0 0 4px}.run{color:var(--muted);font-size:13px;margin:0 0 10px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-size:13px;color:var(--muted)}main{max-width:900px;margin:0 auto;padding:12px 16px 40px}
.job{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.score{flex:0 0 48px;height:48px;border-radius:8px;background:var(--tag);display:grid;place-items:center;font-weight:700;color:var(--accent)}
.body{min-width:0;flex:1}h2{font-size:16px;margin:0}h2 a{color:var(--ink);text-decoration:none}h2 a:hover{color:var(--accent);text-decoration:underline}
.meta{color:var(--muted);font-size:13px;margin:2px 0 6px}.src{border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px}
.new{background:var(--accent);color:var(--card);font-size:11px;border-radius:4px;padding:1px 6px;vertical-align:middle}
.tag{display:inline-block;background:var(--tag);border-radius:999px;padding:1px 9px;font-size:12px;margin:0 4px 4px 0}
.snippets{margin:6px 0 0;padding-left:18px;font-size:14px}.snippets li{margin:3px 0}mark{background:var(--mark);color:inherit;border-radius:2px}
.empty{color:var(--muted)}
</style></head><body>
<header><h1>{{TITLE}}</h1><p class="run">{{RUN_INFO}} · <span id="shown">{{COUNT}}</span> of {{COUNT}} shown</p>
<div class="controls"><input type="search" id="q" placeholder="Filter by title, company, location, skill (e.g. Crestron, Dallas, live events)">
<label><input type="checkbox" id="onlyNew"> new only</label>
<label>min score <input type="number" id="min" value="0" min="0" style="width:60px"></label></div></header>
<main id="list">{{CARDS}}</main>
<script>
const q=document.getElementById('q'),n=document.getElementById('onlyNew'),m=document.getElementById('min'),shown=document.getElementById('shown');
function apply(){const t=q.value.toLowerCase().split(/\\s+/).filter(Boolean);let c=0;
for(const el of document.querySelectorAll('.job')){const ok=t.every(w=>el.dataset.search.includes(w))&&(!n.checked||el.dataset.new==='1')&&(+el.dataset.score>=(+m.value||0));
el.style.display=ok?'':'none';if(ok)c++}shown.textContent=c}
[q,n,m].forEach(e=>e.addEventListener('input',apply));
</script></body></html>
"""
