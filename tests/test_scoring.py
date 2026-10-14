import unittest

from avjobs.scoring import Scorer, html_to_text

AV_TECH = """About the role
We are hiring an AV Technician to support our corporate campus.
Responsibilities:
- Install, configure and troubleshoot audio visual systems in conference rooms
- Program and maintain Crestron and Q-SYS control systems
- Provide live event support including microphones, mixing console and video switcher operation
- Support Zoom Rooms and Teams Rooms video conferencing
Qualifications: CTS certification preferred. Familiar with Dante and signal flow."""

SECURITY_ENG = """Security Engineer. Manage antivirus and EDR tooling across endpoints.
Must be available for on-call. Experience with SIEM, AV/EDR rollouts."""

OFFICE_ADMIN = """Office Coordinator. Book conference rooms, order supplies,
and set up the projector for monthly all-hands meetings."""


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.scorer = Scorer("audiovisual")

    def test_av_job_scores_high_with_tags_and_snippets(self):
        s = self.scorer.score("AV Technician", AV_TECH)
        self.assertGreater(s.total, 40)
        self.assertIn("Control & DSP", s.tags)
        self.assertIn("Live events", s.tags)
        self.assertTrue(any("Crestron" in snip for snip in s.snippets))
        self.assertLessEqual(len(s.snippets), 3)

    def test_antivirus_av_is_not_audio_visual(self):
        s = self.scorer.score("Security Engineer", SECURITY_ENG)
        self.assertEqual(s.total, 0)

    def test_lowercase_av_inside_words_does_not_match(self):
        s = self.scorer.score("Data Analyst", "Must be available, with savvy in Avro and Java.")
        self.assertEqual(s.total, 0)

    def test_light_av_duties_score_low_but_nonzero(self):
        s = self.scorer.score("Office Coordinator", OFFICE_ADMIN)
        self.assertGreater(s.total, 0)
        self.assertLess(s.total, 6)

    def test_title_match_outweighs_body_match(self):
        in_title = self.scorer.score("Crestron Programmer", "Join our team.")
        in_body = self.scorer.score("Programmer", "Crestron experience.")
        self.assertGreater(in_title.total, in_body.total)

    def test_extra_terms(self):
        scorer = Scorer("audiovisual", ["Barco"])
        self.assertGreater(scorer.score("Tech", "Barco projector maintenance").total,
                           self.scorer.score("Tech", "Barco projector maintenance").total)

    def test_autonomous_profile(self):
        scorer = Scorer("autonomous")
        s = scorer.score("Perception Engineer", "Build lidar sensor fusion for our self-driving trucks using ROS2.")
        self.assertGreater(s.total, 15)
        self.assertEqual(scorer.score("AV Technician", AV_TECH).total < s.total, True)

    def test_unknown_profile(self):
        with self.assertRaises(ValueError):
            Scorer("nope")


class HtmlToTextTests(unittest.TestCase):
    def test_entity_escaped_html_like_greenhouse(self):
        raw = "&lt;p&gt;Install &amp;amp; test&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Crestron&lt;/li&gt;&lt;li&gt;Extron&lt;/li&gt;&lt;/ul&gt;"
        self.assertEqual(html_to_text(raw), "Install & test\nCrestron\nExtron")

    def test_plain_text_passthrough(self):
        self.assertEqual(html_to_text("  hello   world \n\n x "), "hello world\nx")


if __name__ == "__main__":
    unittest.main()
