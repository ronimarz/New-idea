import contextlib
import csv
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from avjobs import cli
from avjobs.sources import Job

JOBS = [
    Job("remotive", "AV Technician", "Acme", "Austin, TX", "https://x/1",
        "Install Crestron control systems and troubleshoot audio visual equipment in conference rooms."),
    Job("remotive", "Accountant", "Acme", "Austin, TX", "https://x/2", "Reconcile ledgers."),
    Job("remotive", "Event Producer", "Beta", "Remote", "https://x/3",
        "Run live events: mixing console, wireless mics, livestream to YouTube."),
]


class CliTests(unittest.TestCase):
    def run_cli(self, out: Path, *extra):
        cfg = out / "config.toml"
        cfg.write_text('min_score = 6\n[sources]\nenabled = ["fake"]\n')
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(cli.SOURCES, {"fake": lambda c, t: list(JOBS)}, clear=True), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(cli.main(["-c", str(cfg), "--out", str(out), *extra]), 0)
        return stdout.getvalue()

    def test_end_to_end_report_and_new_tracking(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            first = self.run_cli(out)
            self.assertIn("2 AV-related postings (2 new) out of 3 scanned", first)
            self.assertNotIn("Accountant", first)

            [csv_path] = out.glob("*.csv")
            rows = list(csv.DictReader(csv_path.open()))
            self.assertEqual([r["title"] for r in rows], ["AV Technician", "Event Producer"])
            html = next(out.glob("*.html")).read_text()
            self.assertIn("<mark>Crestron</mark>", html)
            self.assertIn('class="new"', html)

            for p in list(out.glob("*.csv")) + list(out.glob("*.html")):
                p.unlink()
            second = self.run_cli(out)
            self.assertIn("(0 new)", second)


if __name__ == "__main__":
    unittest.main()
