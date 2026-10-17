"""Tests for trendspotter, using sample charts in the shape each source serves them."""

import contextlib
import datetime as dt
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from trendspotter import cli, sources
from trendspotter.sources import ChartEntry
from trendspotter.trends import add_snapshot, find_trends, song_key

KWORB_PAGE = """<html><body><table class="sortable">
<thead><tr><th>Pos</th><th>P+</th><th>Artist and Title</th><th>Days</th><th>Pk</th><th>Streams</th></tr></thead>
<tbody>
<tr><td>1</td><td>=</td><td class="text mp"><div><a href="../artist/a.html">Big Star</a> - <a href="../track/1.html">Old Smash</a></div></td><td>140</td><td>1</td><td>2,000,000</td></tr>
<tr><td>2</td><td>+30</td><td class="text mp"><div><a>Newcomer</a> - <a>Rocket (feat. Guest)</a></div></td><td>9</td><td>2</td><td>900,000</td></tr>
<tr><td>3</td><td>NEW</td><td class="text mp"><div><a>Fresh &amp; Co</a> - <a>Debut</a></div></td><td>1</td><td>3</td><td>800,000</td></tr>
<tr><td>4</td><td>-2</td><td class="text mp"><div><a>Fader</a> - <a>Going Down</a></div></td><td>20</td><td>1</td><td>700,000</td></tr>
</tbody></table></body></html>"""

APPLE_JSON = json.dumps({"feed": {"results": [
    {"artistName": "Big Star", "name": "Old Smash", "url": "https://music.apple.com/1"},
    {"artistName": "Newcomer & Guest", "name": "Rocket", "url": "https://music.apple.com/2"},
    {"artistName": "Fader", "name": "Going Down", "url": "https://music.apple.com/3"},
]}})


def entry(source, rank, artist, title, size=50, **kw):
    return ChartEntry(source, rank, artist, title, size, **kw)


class SourceTests(unittest.TestCase):
    def test_kworb(self):
        rows = sources.parse_kworb(KWORB_PAGE)
        self.assertEqual([(r.rank, r.artist, r.title) for r in rows][:3],
                         [(1, "Big Star", "Old Smash"), (2, "Newcomer", "Rocket (feat. Guest)"), (3, "Fresh & Co", "Debut")])
        self.assertEqual([r.move for r in rows], [0, 30, None, -2])
        self.assertEqual([r.is_new for r in rows], [False, False, True, False])
        self.assertEqual(rows[0].days, 140)
        self.assertEqual(rows[0].chart_size, 4)

    def test_kworb_unexpected_layout_is_an_error_not_garbage(self):
        with self.assertRaises(ValueError):
            sources.parse_kworb("<table><tr><th>Song</th></tr></table>")

    def test_apple(self):
        rows = sources.fetch_apple({}, lambda url: APPLE_JSON)
        self.assertEqual([(r.rank, r.title, r.chart_size) for r in rows][1], (2, "Rocket", 3))

    def test_lastfm_needs_key(self):
        with self.assertRaises(sources.SourceSkipped):
            sources.fetch_lastfm({}, lambda url: "")

    def test_lastfm(self):
        payload = json.dumps({"tracks": {"track": [{"name": "Rocket", "artist": {"name": "Newcomer"}, "url": "u"}]}})
        [row] = sources.fetch_lastfm({"api_key": "k"}, lambda url: payload)
        self.assertEqual((row.source, row.rank, row.artist), ("lastfm", 1, "Newcomer"))


class KeyTests(unittest.TestCase):
    def test_same_song_across_charts(self):
        self.assertEqual(song_key("Newcomer", "Rocket (feat. Guest)"), song_key("Newcomer & Guest", "Rocket"))
        self.assertEqual(song_key("Doja Cat, SZA", "Kiss Me [with SZA]"), "doja cat|kiss me")

    def test_different_songs_stay_different(self):
        self.assertNotEqual(song_key("A", "Song"), song_key("A", "Song (Remix)"))


class TrendTests(unittest.TestCase):
    today = dt.date(2026, 10, 17)

    def history(self, days_ago, entries):
        return add_snapshot({}, self.today - dt.timedelta(days=days_ago), entries)

    def test_climbers_beat_everyone_else(self):
        hist = self.history(3, [entry("apple", 40, "Riser", "Up"), entry("apple", 5, "Fader", "Down"),
                                entry("apple", 20, "Steady", "Same")])
        today = [entry("apple", 12, "Riser", "Up"), entry("apple", 30, "Fader", "Down"),
                 entry("apple", 20, "Steady", "Same"), entry("apple", 35, "Brand", "New")]
        trends = find_trends(today, hist, self.today)
        self.assertEqual([t.title for t in trends], ["Up", "New"])
        self.assertEqual(trends[0].score, 56)  # climbed 28 of 50 places
        self.assertTrue(trends[1].climbs[0].new)

    def test_rising_on_two_charts_gets_a_bonus(self):
        hist = add_snapshot(self.history(3, [entry("apple", 40, "A", "Two")]), self.today - dt.timedelta(days=3),
                            [entry("apple", 40, "A", "Two"), entry("spotify", 40, "A", "Two")])
        [t] = find_trends([entry("apple", 30, "A", "Two"), entry("spotify", 30, "A", "Two")], hist, self.today)
        self.assertEqual(t.score, 20 + 20 + 15)
        self.assertIn("rising on 2 charts", t.notes)

    def test_top_hits_and_old_songs_score_lower(self):
        [hit] = find_trends([entry("spotify", 3, "Big", "Hit", move=20)], {}, self.today)
        [old] = find_trends([entry("spotify", 23, "Old", "Song", move=20, days=200)], {}, self.today)
        self.assertEqual((hit.score, old.score), (20, 20))
        self.assertIn("already a top-10 hit", hit.notes)

    def test_first_run_uses_the_charts_own_movement(self):
        trends = find_trends(sources.parse_kworb(KWORB_PAGE), {}, self.today)
        self.assertEqual([t.title for t in trends], ["Rocket (feat. Guest)", "Debut"])
        self.assertEqual(trends[0].climbs[0].places, 4)  # a jump bigger than the chart counts as the whole chart

    def test_first_run_without_movement_info_finds_nothing(self):
        self.assertEqual(find_trends([entry("apple", 5, "A", "B")], {}, self.today), [])

    def test_uses_snapshot_from_about_lookback_days_ago(self):
        hist = self.history(7, [entry("apple", 50, "A", "B")])
        hist = add_snapshot(hist, self.today - dt.timedelta(days=3), [entry("apple", 45, "A", "B")])
        hist = add_snapshot(hist, self.today - dt.timedelta(days=1), [entry("apple", 20, "A", "B")])
        [t] = find_trends([entry("apple", 10, "A", "B")], hist, self.today, lookback=3)
        self.assertEqual(t.climbs[0].places, 35)

    def test_old_history_is_dropped(self):
        hist = self.history(90, [entry("apple", 1, "A", "B")])
        hist = add_snapshot(hist, self.today, [])
        self.assertEqual(list(hist), [self.today.isoformat()])


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.cfg = self.dir / "trendspotter.toml"
        self.cfg.write_text('sources = ["apple", "spotify"]\nmin_score = 1\n')

    def run_cli(self, pages, *args):
        def get(url):
            for prefix, page in pages.items():
                if url.startswith(prefix):
                    if isinstance(page, Exception):
                        raise page
                    return page
            raise AssertionError(url)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sources, "http_get_text", get), mock.patch.object(cli, "http_get_text", get), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(["-c", str(self.cfg), "--out", str(self.dir / "trends"), *args])
        return code, out.getvalue(), err.getvalue()

    def test_run_writes_report_and_history(self):
        pages = {"https://rss.applemarketingtools.com/": APPLE_JSON, "https://kworb.net/": KWORB_PAGE}
        code, out, err = self.run_cli(pages)
        self.assertEqual(code, 0)
        self.assertIn("[apple] 3 songs", err)
        self.assertIn("Fresh & Co - Debut", out)
        self.assertIn("(2 new since last report)", out)
        [report] = (self.dir / "trends").glob("rising_*.html")
        self.assertIn("tiktok.com/search?q=Fresh", report.read_text())
        history = json.loads((self.dir / "trends" / "history.json").read_text())
        self.assertIn("newcomer|rocket", history[dt.date.today().isoformat()]["apple"])

        _, out, _ = self.run_cli(pages)
        self.assertIn("(0 new since last report)", out)

    def test_one_chart_failing_still_reports_the_others(self):
        pages = {"https://rss.applemarketingtools.com/": sources.urllib.error.URLError("down"),
                 "https://kworb.net/": KWORB_PAGE}
        code, out, err = self.run_cli(pages)
        self.assertEqual(code, 0)
        self.assertIn("[apple] failed", err)
        self.assertIn("Debut", out)

    def test_no_charts_at_all(self):
        down = sources.urllib.error.URLError("down")
        code, out, _ = self.run_cli({"https://rss.applemarketingtools.com/": down, "https://kworb.net/": down})
        self.assertEqual(code, 1)
        self.assertIn("Couldn't get any charts", out)


if __name__ == "__main__":
    unittest.main()
