"""Parsing tests for each job source, using sample payloads in each API's documented shape."""

import unittest
import urllib.error

from avjobs import sources
from avjobs.sources import SourceSkipped

DESC = "<p>Install and troubleshoot audio visual systems. Crestron programming.</p>"


def fake_get(routes):
    calls = []

    def get(url, headers):
        calls.append((url, headers))
        for prefix, payload in routes.items():
            if url.startswith(prefix):
                if isinstance(payload, Exception):
                    raise payload
                return payload
        raise AssertionError(f"unexpected URL {url}")

    get.calls = calls
    return get


class SourceParsingTests(unittest.TestCase):
    def test_greenhouse(self):
        get = fake_get({"https://boards-api.greenhouse.io/v1/boards/acme/": {"jobs": [{
            "title": "AV Technician", "company_name": "Acme", "location": {"name": "Austin, TX"},
            "absolute_url": "https://boards.greenhouse.io/acme/jobs/1", "updated_at": "2026-10-01T12:00:00-04:00",
            "content": "&lt;p&gt;Install and troubleshoot audio visual systems.&lt;/p&gt;"}]}})
        [job] = sources.fetch_greenhouse({"companies": ["acme"]}, [], get)
        self.assertEqual((job.title, job.company, job.location, job.posted), ("AV Technician", "Acme", "Austin, TX", "2026-10-01"))
        self.assertEqual(job.description, "Install and troubleshoot audio visual systems.")

    def test_greenhouse_missing_board_is_a_warning_not_a_crash(self):
        err = urllib.error.HTTPError("u", 404, "Not Found", {}, None)
        get = fake_get({"https://boards-api.greenhouse.io/v1/boards/nope/": err})
        self.assertEqual(sources.fetch_greenhouse({"companies": ["nope"]}, [], get), [])

    def test_lever(self):
        get = fake_get({"https://api.lever.co/v0/postings/acme": [{
            "text": "Event Production Tech", "categories": {"location": "Remote"},
            "hostedUrl": "https://jobs.lever.co/acme/abc", "createdAt": 1790000000000,
            "descriptionPlain": "Run live events.", "additionalPlain": "",
            "lists": [{"text": "Duties", "content": "<li>Mixing console operation</li>"}],
            "salaryRange": {"min": 60000, "max": 80000, "interval": "per-year-salary"}}]})
        [job] = sources.fetch_lever({"companies": ["acme"]}, [], get)
        self.assertIn("Mixing console operation", job.description)
        self.assertEqual(job.salary, "$60,000–$80,000 per-year-salary")
        self.assertRegex(job.posted, r"^\d{4}-\d{2}-\d{2}$")

    def test_ashby(self):
        get = fake_get({"https://api.ashbyhq.com/posting-api/job-board/acme": {"jobs": [{
            "title": "Media Systems Engineer", "location": "NYC", "isRemote": True,
            "jobUrl": "https://jobs.ashbyhq.com/acme/1", "publishedAt": "2026-09-30T00:00:00Z",
            "descriptionPlain": "Q-SYS design."}]}})
        [job] = sources.fetch_ashby({"companies": ["acme"]}, [], get)
        self.assertEqual(job.location, "NYC (remote ok)")

    def test_remotive_dedupes_across_search_terms(self):
        payload = {"jobs": [{"title": "AV Support", "company_name": "R", "url": "https://remotive.com/1",
                             "candidate_required_location": "USA", "publication_date": "2026-10-02T00:00:00",
                             "description": DESC, "salary": ""}]}
        get = fake_get({"https://remotive.com/api/remote-jobs": payload})
        jobs = sources.fetch_remotive({}, ["audio visual", "Crestron"], get)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(len(get.calls), 2)

    def test_adzuna_requires_keys(self):
        with self.assertRaises(SourceSkipped):
            sources.fetch_adzuna({}, ["audio visual"])

    def test_adzuna(self):
        get = fake_get({"https://api.adzuna.com/v1/api/jobs/us/search/1": {"results": [{
            "title": "AV Installer", "company": {"display_name": "Integrator Co"},
            "location": {"display_name": "Denver, Colorado"}, "redirect_url": "https://adzuna/1",
            "description": "Rack build and signal flow", "created": "2026-10-03T00:00:00Z",
            "salary_min": 50000, "salary_max": 65000}]}})
        [job] = sources.fetch_adzuna({"app_id": "i", "app_key": "k", "where": "Denver"}, ["audio visual", "Crestron"], get)
        self.assertEqual(job.company, "Integrator Co")
        self.assertIn("what_or=audio+visual+Crestron", get.calls[0][0])
        self.assertIn("where=Denver", get.calls[0][0])

    def test_usajobs(self):
        get = fake_get({"https://data.usajobs.gov/api/search": {"SearchResult": {"SearchResultItems": [{
            "MatchedObjectDescriptor": {
                "PositionTitle": "Audiovisual Production Specialist", "OrganizationName": "Department of X",
                "PositionLocationDisplay": "Washington, DC", "PositionURI": "https://usajobs.gov/job/1",
                "PublicationStartDate": "2026-10-04", "QualificationSummary": "Video switcher experience",
                "PositionRemuneration": [{"MinimumRange": "70000", "MaximumRange": "90000", "Description": "Per Year"}],
                "UserArea": {"Details": {"JobSummary": "Support events.", "MajorDuties": ["Operate PTZ cameras"]}}}}]}}})
        [job] = sources.fetch_usajobs({"api_key": "k", "email": "me@example.com"}, ["audiovisual"], get)
        self.assertIn("Operate PTZ cameras", job.description)
        self.assertEqual(get.calls[0][1]["Authorization-Key"], "k")
        self.assertEqual(job.salary, "$70,000–$90,000 Per Year")


if __name__ == "__main__":
    unittest.main()
