"""Tests for flipfinder, using sample pages in the shape Craigslist and eBay serve them."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flipfinder import cli, web
from flipfinder.deals import Item, Selling, evaluate
from flipfinder.web import Listing


def cl_result(title, price, href, where="oakland"):
    return f"""<li class="cl-static-search-result" title="{title}">
  <a href="{href}">
    <div class="title">{title}</div>
    <div class="details"><div class="price">{price}</div><div class="location">
        {where}
    </div></div>
  </a>
</li>"""


CL_PAGE = "<html><body><ol class=\"cl-static-search-results\">" + "".join([
    cl_result("Dyson V10 Absolute &amp; charger", "$45", "https://sfbay.craigslist.org/eby/app/d/1.html"),
    cl_result("Dyson V10 - works great", "$110", "https://sfbay.craigslist.org/eby/app/d/2.html"),
    cl_result("Dyson V10 FOR PARTS", "$20", "https://sfbay.craigslist.org/eby/app/d/3.html"),
    cl_result("Dyson V10 battery only", "$25", "https://sfbay.craigslist.org/eby/app/d/4.html"),
    cl_result("Dyson V10 no price", "", "https://sfbay.craigslist.org/eby/app/d/5.html"),
]) + "</ol></body></html>"

EBAY_PAGE = """<ul class="srp-results">
<li class="s-item s-item__pl-on-bottom"><div class="s-item__title"><span role="heading">Shop on eBay</span></div>
  <span class="s-item__price">$20.00</span></li>
<li class="s-item"><div class="s-item__title"><span>New Listing Dyson V10 Animal Cordless</span></div><span class="s-item__price">$140.00</span></li>
<li class="s-item"><div class="s-item__title"><span>Dyson V10 Absolute</span></div><span class="s-item__price">$150.00</span></li>
<li class="s-item"><div class="s-item__title"><span>Dyson V10 vacuum</span></div><span class="s-item__price">$130.00</span></li>
<li class="s-item"><div class="s-item__title"><span>Dyson V10 lot</span></div><span class="s-item__price">$120.00 to $160.00</span></li>
<li class="s-item"><div class="s-item__title"><span>Dyson V10 for parts</span></div><span class="s-item__price">$30.00</span></li>
<li class="s-card s-card--horizontal"><div class="s-card__title"><span class="su-styled-text">Dyson V10 Motorhead</span></div><span class="s-card__price">$140.00</span></li>
</ul>"""


class ParsingTests(unittest.TestCase):
    def test_craigslist(self):
        listings = web.parse_craigslist(CL_PAGE)
        self.assertEqual([l.price for l in listings], [45, 110, 20, 25])
        self.assertEqual(listings[0].title, "Dyson V10 Absolute & charger")
        self.assertEqual(listings[0].location, "oakland")
        self.assertEqual(listings[0].url, "https://sfbay.craigslist.org/eby/app/d/1.html")

    def test_craigslist_url(self):
        url = web.craigslist_url("sfbay", "dyson v10", {"zip": "94607", "miles": 10})
        self.assertTrue(url.startswith("https://sfbay.craigslist.org/search/sss?query=dyson+v10"))
        self.assertIn("postal=94607", url)
        self.assertIn("purveyor=owner", url)

    def test_craigslist_needs_city(self):
        with self.assertRaises(ValueError):
            web.fetch_craigslist({}, "dyson", lambda u: "")

    def test_ebay_sold_skips_placeholders_ranges_and_parts(self):
        sold = web.parse_ebay_sold(EBAY_PAGE, ["for parts"])
        self.assertEqual([t for t, _ in sold][:2], ["Dyson V10 Animal Cordless", "Dyson V10 Absolute"])
        self.assertNotIn("Dyson V10 lot", [t for t, _ in sold])
        self.assertNotIn(30.0, [p for _, p in sold])
        self.assertIn(("Dyson V10 Motorhead", 140.0), sold)

    def test_typical_price_needs_a_few_sales(self):
        self.assertIsNone(web.typical_price([100, 120]))
        self.assertEqual(web.typical_price([10, 100, 110, 120, 130, 140, 150, 160, 170, 900]), 135)

    def test_typical_price_ignores_accessories(self):
        self.assertEqual(web.typical_price([25, 30, 140, 150, 160]), 150)

    def test_ebay_resale_applies_item_filters(self):
        price, sales = web.ebay_resale("dyson v10", ["for parts"], ["absolute"], get=lambda u: EBAY_PAGE)
        self.assertEqual(sales, 1)  # only one title says Absolute
        self.assertIsNone(price)    # ...which isn't enough to trust

    def test_price_parsing(self):
        self.assertEqual(web.parse_price("$1,250.50"), 1250.5)
        self.assertIsNone(web.parse_price("$20.00 to $30.00"))
        self.assertIsNone(web.parse_price("free"))


class DealTests(unittest.TestCase):
    item = Item("Dyson V10", "dyson v10", resale=140, exclude=("battery only",))

    def deal(self, title, price, selling=Selling(min_profit=40)):
        return evaluate(self.item, Listing("craigslist", title, price, "u"), selling)

    def test_profit_selling_locally(self):
        d = self.deal("Dyson V10", 60)
        self.assertEqual(d.profit, 80)
        self.assertFalse(d.suspicious)

    def test_ebay_fees_and_shipping_reduce_profit(self):
        ebay = Selling(fee_percent=13.6, fee_fixed=0.40, shipping=20, min_profit=10)
        self.assertEqual(self.deal("Dyson V10", 60, ebay).profit, round(140 * 0.864 - 0.40 - 20 - 60, 2))

    def test_too_little_profit_is_skipped(self):
        self.assertIsNone(self.deal("Dyson V10", 110))

    def test_broken_and_accessory_listings_are_skipped(self):
        self.assertIsNone(self.deal("Dyson V10 - not working", 50))
        self.assertIsNone(self.deal("Dyson V10 battery only", 50))
        self.assertIsNone(self.deal("Dyson V10 wand", 20))  # under the 20%-of-resale floor

    def test_exclude_matches_whole_words(self):
        self.assertIsNotNone(self.deal("Dyson V10, repaired filter, works", 60))

    def test_very_cheap_is_flagged(self):
        self.assertTrue(self.deal("Dyson V10", 40).suspicious)

    def test_max_buy(self):
        self.assertEqual(Selling(min_profit=40).max_buy(140), 100)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.cfg = self.dir / "flipfinder.toml"
        self.cfg.write_text("""
[craigslist]
city = "sfbay"
[selling]
min_profit = 40
[[items]]
name = "Dyson V10"
search = "dyson v10"
resale = 100
exclude = ["battery only"]
""")

    def run_cli(self, *args, pages=None):
        pages = pages or {"https://sfbay.craigslist.org/": CL_PAGE, "https://www.ebay.com/": EBAY_PAGE}

        def get(url):
            for prefix, page in pages.items():
                if url.startswith(prefix):
                    if isinstance(page, Exception):
                        raise page
                    return page
            raise AssertionError(url)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(web, "http_get_text", get), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(["-c", str(self.cfg), "--out", str(self.dir / "deals"), *args])
        return code, out.getvalue(), err.getvalue()

    def test_scan_uses_ebay_price_and_writes_report(self):
        code, out, err = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("typically sells for $140", err)
        self.assertIn("1 deal (1 new)", out)  # the $110 one only makes $30
        self.assertIn("+$95", out)
        self.assertIn("unusually cheap", out)
        [report] = (self.dir / "deals").glob("deals_*.html")
        self.assertIn("LH_Sold=1", report.read_text())
        prices = json.loads((self.dir / "deals" / "prices.json").read_text())
        self.assertEqual(prices["dyson v10"]["price"], 140)

        _, out, _ = self.run_cli()
        self.assertIn("(0 new)", out)

    def test_scan_falls_back_to_config_price_when_ebay_fails(self):
        code, out, err = self.run_cli(pages={
            "https://sfbay.craigslist.org/": CL_PAGE,
            "https://www.ebay.com/": web.urllib.error.URLError("blocked")})
        self.assertEqual(code, 0)
        self.assertIn("using your config price $100", err)
        self.assertIn("+$55", out)

    def test_check(self):
        code, out, _ = self.run_cli("--no-ebay", "check", "dyson v10", "50")
        self.assertEqual(code, 0)
        self.assertIn("BUY", out)
        _, out, _ = self.run_cli("--no-ebay", "check", "dyson v10", "90")
        self.assertIn("PASS at this price. Offer $60 or less", out)
        self.assertIn("you'd lose", self.run_cli("--no-ebay", "check", "dyson v10", "120")[1])
        _, out, _ = self.run_cli("check", "dyson v10", "90")  # eBay says it's worth $140
        self.assertIn("BUY", out)

    def test_check_unknown_item_uses_ebay(self):
        _, out, _ = self.run_cli("check", "some other thing", "60")
        self.assertIn("median of", out)
        self.assertIn("BUY", out)

    def test_price(self):
        code, out, _ = self.run_cli("price", "dyson v10")
        self.assertEqual(code, 0)
        self.assertIn("$140", out)
        self.assertIn("buy for $100 or less", out)


if __name__ == "__main__":
    unittest.main()
