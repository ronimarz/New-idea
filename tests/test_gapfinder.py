"""Tests for gapfinder, using sample feeds in the shape each source serves them."""

import contextlib
import datetime as dt
import gzip
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gapfinder import cli, sources
from gapfinder.signals import detect, group_hits, terms
from gapfinder.sources import Post

TODAY = dt.date.today()
RECENT = (TODAY - dt.timedelta(days=2)).isoformat()


def rss_entry(sub, title, body, link, when=RECENT):
    return f"""<entry>
  <author><name>/u/someone</name></author>
  <category term="{sub}" label="r/{sub}"/>
  <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;{body}&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href="https://www.reddit.com/user/someone"&gt; /u/someone &lt;/a&gt;</content>
  <id>t3_{abs(hash(link)) % 99999}</id>
  <link href="{link}"/>
  <updated>{when}T10:00:00+00:00</updated>
  <published>{when}T10:00:00+00:00</published>
  <title>{title}</title>
</entry>"""


def rss(*entries):
    return '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' + "".join(entries) + "</feed>"


SMALLBIZ = rss(
    rss_entry("smallbusiness", "Is there an app that sends invoice reminders by text?",
              "I spend hours chasing clients. I&amp;#39;d pay $20 a month for automatic invoice reminders by text message.",
              "https://www.reddit.com/r/smallbusiness/comments/1/"),
    rss_entry("smallbusiness", "Old post about invoices", "Is there a tool for invoice reminders?",
              "https://www.reddit.com/r/smallbusiness/comments/old/", when="2020-01-01"),
    rss_entry("smallbusiness", "Just opened my second location!", "So excited, thanks everyone.",
              "https://www.reddit.com/r/smallbusiness/comments/2/"),
)
FREELANCE = rss(rss_entry("freelance", "Why is there no simple way to send invoice reminders?",
                          "Clients forget to pay. Text reminders for unpaid invoices would save me so much time.",
                          "https://www.reddit.com/r/freelance/comments/3/"))
SMT = rss(rss_entry("SomebodyMakeThis", "A setlist planner for bands",
                    "Shared setlists that sync to everyone's phone before a gig.",
                    "https://www.reddit.com/r/SomebodyMakeThis/comments/4/"))
HN = json.dumps({"hits": [
    {"objectID": "101", "comment_text": "<p>Honestly I would pay for invoice reminders that text the client automatically.</p>",
     "story_title": "Ask HN: What tools do you wish existed?", "created_at_i": int(dt.datetime.now().timestamp()) - 3600, "points": None},
]})
SE = json.dumps({"items": [
    {"title": "Software to plan band setlists and share with members", "body": "<p>Need something free for Android.</p>",
     "link": "https://softwarerecs.stackexchange.com/q/9", "creation_date": int(dt.datetime.now().timestamp()) - 7200, "score": 3},
]})


def post(title, text="", **kw):
    return Post(kw.pop("source", "reddit"), kw.pop("community", "r/test"), title, text,
                kw.pop("url", f"u/{title}"), kw.pop("created", TODAY), **kw)


class SourceTests(unittest.TestCase):
    def test_reddit_rss(self):
        posts = sources.parse_reddit_rss(SMALLBIZ)
        self.assertEqual(len(posts), 3)
        p = posts[0]
        self.assertEqual((p.community, p.url), ("r/smallbusiness", "https://www.reddit.com/r/smallbusiness/comments/1/"))
        self.assertIn("I'd pay $20 a month", p.text)
        self.assertNotIn("submitted by", p.text)

    def test_reddit_skips_old_posts_and_marks_request_subs(self):
        feeds = {"smallbusiness/search": SMALLBIZ, "SomebodyMakeThis/new": SMT}
        get = lambda url: next(v for k, v in feeds.items() if k in url)
        cfg = {"subreddits": ["smallbusiness"], "request_subreddits": ["SomebodyMakeThis"]}
        posts = sources.fetch_reddit(cfg, TODAY - dt.timedelta(days=30), get, pause=0)
        self.assertEqual([p.url.split("/")[-2] for p in posts], ["1", "2", "4"])
        self.assertEqual([p.always_request for p in posts], [False, False, True])

    def test_one_broken_subreddit_doesnt_stop_the_rest(self):
        def get(url):
            if "bad" in url:
                raise sources.urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
            return FREELANCE
        posts = sources.fetch_reddit({"subreddits": ["bad", "freelance"]}, TODAY - dt.timedelta(days=30), get, pause=0)
        self.assertEqual(len(posts), 1)

    def test_hackernews(self):
        posts = sources.fetch_hackernews({"phrases": ["i would pay", "i'd pay"]}, TODAY - dt.timedelta(days=30), lambda u: HN)
        self.assertEqual(len(posts), 1)  # same hit from two searches counted once
        self.assertEqual(posts[0].url, "https://news.ycombinator.com/item?id=101")
        self.assertIn("I would pay", posts[0].text)

    def test_stackexchange(self):
        [p] = sources.fetch_stackexchange({"sites": ["softwarerecs"]}, TODAY, lambda u: SE)
        self.assertTrue(p.always_request)
        self.assertEqual(p.text, "Need something free for Android.")

    def test_gzip_responses_are_decoded(self):
        class Resp(io.BytesIO):
            headers = mock.Mock(get=lambda k, d=None: "gzip", get_content_charset=lambda: "utf-8")
            def __enter__(self): return self
            def __exit__(self, *a): pass
        with mock.patch.object(sources.urllib.request, "urlopen", lambda req, timeout: Resp(gzip.compress(b'{"ok": 1}'))):
            self.assertEqual(sources.http_get_text("https://x"), '{"ok": 1}')


class SignalTests(unittest.TestCase):
    def test_strong_and_weak_signals(self):
        pay = detect(post("Invoice reminders", "I'd pay for this. Seriously."))
        ask = detect(post("Is there an app for tracking gigs?"))
        self.assertEqual(pay.labels, ["would pay"])
        self.assertEqual(pay.quote, "I'd pay for this.")
        self.assertEqual(ask.labels, ["looking for a tool"])
        self.assertEqual(ask.quote, "Is there an app for tracking gigs?")
        self.assertGreater(pay.strength, ask.strength)

    def test_ordinary_posts_are_ignored(self):
        self.assertIsNone(detect(post("Just opened my second location!", "So excited.")))
        self.assertIsNone(detect(post("I paid my taxes", "Is there anything else to do today?")))

    def test_shutdowns_and_price_hikes(self):
        h = detect(post("Mint is shutting down", "Looking for alternatives to Mint for budgeting."))
        self.assertIn("switching away", h.labels)

    def test_request_communities_always_count(self):
        h = detect(post("A setlist planner for bands", always_request=True))
        self.assertEqual(h.labels, ["asking for software"])

    def test_focus_words(self):
        p = post("Is there an app for invoices?")
        self.assertIsNone(detect(p, ["music"]))
        self.assertIsNotNone(detect(p, ["invoice"]))

    def test_terms_drop_filler(self):
        self.assertEqual(terms("Is there an app that sends invoice reminders by text?"),
                         {"send", "invoice", "reminder", "text"})

    def test_similar_asks_are_grouped(self):
        hits = [detect(p) for p in [
            post("Is there an app that sends invoice reminders by text?", "I'd pay for it", community="r/smallbusiness"),
            post("Why is there no simple way to send invoice reminders?", "text reminders for unpaid invoices", community="r/freelance"),
            post("Is there a tool to plan band setlists?", community="r/musicians"),
        ]]
        groups = group_hits(hits)
        self.assertEqual([len(g.hits) for g in groups], [2, 1])
        self.assertEqual(groups[0].communities, ["r/freelance", "r/smallbusiness"])
        self.assertIn("invoice", groups[0].keywords)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.cfg = self.dir / "gapfinder.toml"
        self.cfg.write_text("""
sources = ["reddit", "hackernews", "stackexchange"]
[reddit]
subreddits = ["smallbusiness", "freelance"]
request_subreddits = ["SomebodyMakeThis"]
[hackernews]
phrases = ["i would pay"]
[stackexchange]
sites = ["softwarerecs"]
""")
        self.feeds = {"/r/smallbusiness/": SMALLBIZ, "/r/freelance/": FREELANCE, "/r/SomebodyMakeThis/": SMT,
                      "hn.algolia.com": HN, "api.stackexchange.com": SE}

    def run_cli(self, *args):
        def get(url):
            for key, page in self.feeds.items():
                if key in url:
                    if isinstance(page, Exception):
                        raise page
                    return page
            raise AssertionError(url)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "http_get_text", get), mock.patch.object(sources.time, "sleep"), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(["-c", str(self.cfg), "--out", str(self.dir / "gaps"), *args])
        return code, out.getvalue(), err.getvalue()

    def test_run_groups_repeated_asks_and_writes_report(self):
        code, out, err = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("[reddit] 4 posts", err)
        self.assertIn("2 unmet needs", out)
        self.assertIn("3 requests · Hacker News, r/freelance, r/smallbusiness", out)  # invoice reminders, 3 places
        [report] = (self.dir / "gaps").glob("gaps_*.html")
        self.assertIn("setlist", report.read_text().lower())

        _, out, _ = self.run_cli()
        self.assertIn("0 with new posts", out)

    def test_focus(self):
        _, out, _ = self.run_cli("--focus", "setlist")
        self.assertIn("1 unmet need from", out)
        self.assertIn("setlist", out.lower())

    def test_a_failing_source_doesnt_stop_the_run(self):
        self.feeds["hn.algolia.com"] = sources.urllib.error.URLError("down")
        code, out, err = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("[hackernews] failed", err)

    def test_nothing_reachable(self):
        self.feeds = {k: sources.urllib.error.URLError("down") for k in self.feeds}
        code, out, _ = self.run_cli()
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
