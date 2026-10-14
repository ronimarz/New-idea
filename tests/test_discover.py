"""Tests for finding a company's careers page and job board from its website."""

import json
import unittest

from avjobs import discover
from avjobs.discover import Board

HOME = """<html><body><nav>
<a href="/about">About</a><a href="/solutions">Solutions</a>
<a href="/company/careers">Careers</a><a href="mailto:hi@x.com">Email</a>
<a href="https://partner.com/jobs">Partner jobs</a></nav></body></html>"""

CAREERS_GREENHOUSE = """<h1>Join us</h1>
<div id="grnhse_app"></div>
<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeav"></script>"""

CAREERS_LANDING = """<h1>Careers at Acme</h1><a href="/company/careers/openings">See open positions</a>"""
OPENINGS_WORKDAY = """<a href="https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers">Search jobs</a>"""

CAREERS_JSONLD = """<script type="application/ld+json">""" + json.dumps({"@context": "https://schema.org", "@graph": [
    {"@type": "Organization", "name": "Acme"},
    {"@type": "JobPosting", "title": "AV Field Technician", "datePosted": "2026-10-05",
     "hiringOrganization": {"@type": "Organization", "name": "Acme AV"},
     "jobLocation": {"@type": "Place", "address": {"addressLocality": "Phoenix", "addressRegion": "AZ"}},
     "description": "<p>Install Extron switchers and projectors.</p>", "url": "https://acme.com/jobs/7"}]}) + "</script>"


def fake_fetch(pages):
    def fetch(url):
        if url not in pages:
            raise discover.urllib.error.URLError("404")
        return url, pages[url]
    return fetch


class DetectBoardTests(unittest.TestCase):
    def test_patterns(self):
        cases = {
            "https://boards.greenhouse.io/acme/jobs/123": Board("greenhouse", "acme"),
            "https://job-boards.greenhouse.io/acme": Board("greenhouse", "acme"),
            "https://boards.greenhouse.io/embed/job_board?for=acme": Board("greenhouse", "acme"),
            "https://jobs.lever.co/acme/abc-123": Board("lever", "acme"),
            "https://jobs.ashbyhq.com/Acme%20AV": Board("ashby", "Acme AV"),
            "https://careers.smartrecruiters.com/AcmeAV": Board("smartrecruiters", "AcmeAV"),
            "https://acme.wd1.myworkdayjobs.com/en-US/External/job/X": Board("workday", "acme", "acme.wd1.myworkdayjobs.com", "External"),
            "https://acme.wd1.myworkdayjobs.com/External": Board("workday", "acme", "acme.wd1.myworkdayjobs.com", "External"),
        }
        for html, expected in cases.items():
            with self.subTest(html=html):
                self.assertEqual(discover.detect_boards(html), [expected])

    def test_nothing_found(self):
        self.assertEqual(discover.detect_boards("<a href='/apply'>Apply</a>"), [])


class FindBoardTests(unittest.TestCase):
    def test_careers_link_from_homepage(self):
        candidates = discover.career_page_candidates("https://www.acme.com/", HOME)
        self.assertEqual(candidates[0], "https://www.acme.com/company/careers")
        self.assertNotIn("mailto:hi@x.com", candidates)

    def test_follows_careers_page_to_embedded_greenhouse(self):
        fetch = fake_fetch({"https://acme.com": HOME, "https://acme.com/company/careers": CAREERS_GREENHOUSE})
        boards, checked, _ = discover.find_boards("acme.com", fetch)
        self.assertEqual(boards, [Board("greenhouse", "acmeav")])
        self.assertEqual(checked, ["https://acme.com/company/careers"])

    def test_follows_one_level_deeper_to_workday(self):
        fetch = fake_fetch({
            "https://acme.com": HOME,
            "https://acme.com/company/careers": CAREERS_LANDING,
            "https://acme.com/company/careers/openings": OPENINGS_WORKDAY,
        })
        boards, _, _ = discover.find_boards("acme.com", fetch)
        self.assertEqual(boards, [Board("workday", "acme", "acme.wd5.myworkdayjobs.com", "AcmeCareers")])

    def test_common_paths_when_homepage_has_no_careers_link(self):
        fetch = fake_fetch({"https://acme.com": "<p>hello</p>", "https://acme.com/jobs": CAREERS_GREENHOUSE})
        boards, _, _ = discover.find_boards("acme.com", fetch)
        self.assertEqual(boards, [Board("greenhouse", "acmeav")])

    def test_jsonld_fallback(self):
        fetch = fake_fetch({"https://acme.com": HOME, "https://acme.com/company/careers": CAREERS_JSONLD})
        jobs, how = discover.jobs_from_company_site("acme.com", ["audio visual"], fetch)
        self.assertEqual(how, "via careers-page structured data")
        [job] = jobs
        self.assertEqual((job.title, job.company, job.location), ("AV Field Technician", "Acme AV", "Phoenix, AZ"))
        self.assertEqual(job.description, "Install Extron switchers and projectors.")

    def test_nothing_found_message(self):
        fetch = fake_fetch({"https://acme.com": HOME, "https://acme.com/company/careers": "<p>Email us your resume</p>"})
        jobs, how = discover.jobs_from_company_site("acme.com", [], fetch)
        self.assertEqual(jobs, [])
        self.assertIn("no job board found", how)


class AtsReaderTests(unittest.TestCase):
    def test_workday(self):
        board = Board("workday", "acme", "acme.wd5.myworkdayjobs.com", "Careers")
        posts = []

        def post(url, payload):
            posts.append((url, payload))
            return {"jobPostings": [{"title": "AV Systems Engineer", "externalPath": "/job/Dallas/AV-Systems-Engineer_R1",
                                     "locationsText": "Dallas, TX", "postedOn": "Posted Today"}]}

        orig = discover._workday_detail
        discover._workday_detail = lambda api, path: {"jobPostingInfo": {"jobDescription": "<p>Design Q-SYS systems</p>"}}
        try:
            [job] = discover.fetch_workday(board, ["audio visual"], post)
        finally:
            discover._workday_detail = orig
        self.assertEqual(posts[0][0], "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs")
        self.assertEqual(posts[0][1]["searchText"], "audio visual")
        self.assertEqual(job.url, "https://acme.wd5.myworkdayjobs.com/Careers/job/Dallas/AV-Systems-Engineer_R1")
        self.assertEqual(job.description, "Design Q-SYS systems")

    def test_smartrecruiters(self):
        def get(url, headers):
            if "/postings?" in url:
                return {"content": [{"id": "9", "name": "AV Tech", "company": {"name": "Acme"},
                                     "location": {"city": "Reno", "region": "NV", "country": "us"},
                                     "releasedDate": "2026-10-06T00:00:00Z", "ref": "https://api.smartrecruiters.com/v1/companies/acme/postings/9"}]}
            return {"jobAd": {"sections": {"jobDescription": {"text": "<p>Crestron</p>"}, "qualifications": {"text": "CTS"}}}}

        [job] = discover.fetch_smartrecruiters("acme", ["audio visual"], get)
        self.assertEqual(job.location, "Reno, NV, us")
        self.assertEqual(job.description, "Crestron\nCTS")


if __name__ == "__main__":
    unittest.main()
