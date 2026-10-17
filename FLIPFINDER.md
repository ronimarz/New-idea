# flipfinder: make ~$500/month flipping used items

`flipfinder` watches Craigslist for popular items priced well below what they actually sell for, and tells you how much you'd make by buying and reselling them. You buy the underpriced one, clean it up, and resell it at the normal price.

It does three things:

| Command | What it does |
|---|---|
| `python -m flipfinder` | Scans Craigslist near you for every item on your watchlist and lists the deals, biggest profit first. |
| `python -m flipfinder check "dyson v10" 60` | You found a listing somewhere else (Facebook Marketplace, OfferUp, a yard sale). Is it worth buying at $60? |
| `python -m flipfinder price "kitchenaid artisan"` | What does this actually sell for used? And what's the most you should pay? |

Resale prices come from recent **sold** eBay listings, which show what people really paid, not what sellers are asking.

## The $500/month math

$500 is about **10 flips at $50 profit**, or 2–3 a week. With 5–10 hours a week:

- **~2 hrs:** check the report each morning and evening (good deals go within hours), and message sellers.
- **~3 hrs:** pick up items, test and clean them, and take good photos.
- **~2 hrs:** list them on Facebook Marketplace (where most local buyers are) and meet buyers.

Start with $200–300 of cash to buy with. Reinvest your first few profits before you start taking money out.

## Setup (one time, about 10 minutes)

1. **Install Python 3.11 or newer** from [python.org/downloads](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"** in the installer.
2. **Download this project:** on GitHub, click **Code → Download ZIP** and unzip it.
3. **Open a terminal in that folder.**
   - Windows: open the folder, click the address bar, type `cmd`, and press Enter.
   - Mac: right-click the folder and choose **New Terminal at Folder**.
4. **Make your config:**
   - Windows: `copy flipfinder.example.toml flipfinder.toml`
   - Mac: `cp flipfinder.example.toml flipfinder.toml`
5. **Open `flipfinder.toml`** in Notepad or TextEdit and set `city` to your Craigslist area: the word before `.craigslist.org` in the address bar when you visit your local Craigslist (e.g. `chicago`, `sfbay`, `dallas`). Optionally add your `zip`.
6. **Run it:** `python -m flipfinder` (on Mac, `python3 -m flipfinder`).

It prints the deals and saves a report in the `deals` folder. Open the `.html` file in your browser: each deal links to the listing, plus a **check sold prices** link so you can see the eBay sales for yourself.

Listings you've already seen are marked, so on later runs look for the **NEW** tag.

### Run it automatically

- **Mac:** run `crontab -e` and add `0 7,12,18 * * * cd /path/to/folder && python3 -m flipfinder`. That runs it at 7am, noon and 6pm.
- **Windows:** open Task Scheduler, choose **Create Basic Task → Daily**, set the program to `python`, the arguments to `-m flipfinder`, and **Start in** to the project folder.

## Your watchlist

The starter watchlist in `flipfinder.toml` is a set of items that are good for beginners: well-known brands, easy to test, and quick to resell locally:

Dyson V10 vacuums · KitchenAid mixers · Herman Miller Aeron and Steelcase Leap chairs · Nintendo Switch OLED · PS5 · Vitamix · Milwaukee M18 FUEL tools

To add your own, copy one of the `[[items]]` blocks:

```toml
[[items]]
name = "DeWalt 20V drill"
search = "dewalt 20v drill"
resale = 90                        # backup price, only used if the eBay lookup fails
exclude = ["battery only", "bare tool"]   # skip listings that say any of these
min_price = 30                     # ignore cheaper listings (usually accessories)
```

**Good items to flip** are things people search for by brand name, that work or don't (no hidden problems), and that are big enough that eBay shipping is a pain. Bulky items like office chairs, mixers and patio furniture flip especially well locally, because few people bother shipping them.

**Avoid** phones (they may be locked or stolen), anything you can't test on the spot, and items you don't know well.

## Settings worth knowing

- `min_profit` in `[selling]`: the smallest profit worth your time. Start at $40.
- `--min-profit 25`: lowers it for one run, e.g. `python -m flipfinder --min-profit 25`.
- **Selling on eBay instead of locally?** In `[selling]` set `fee_percent = 13.6`, `fee_fixed = 0.40` and `shipping` to your typical shipping cost. Profits are recalculated with those.
- `--no-ebay`: skip the eBay price lookups and use the `resale` prices in your config.

## Tips and safety

- **Message fast, and be polite:** "Hi, is this still available? I can pick up today with cash."
- **Test before you pay.** Plug it in, turn it on, and check the serial number on electronics.
- **"Unusually cheap" warnings** mean the price is under 35% of resale. That's sometimes a real steal, but also sometimes a scam, a stolen item, or something broken. Meet in public (many police stations have safe exchange spots) and never pay in advance.
- **Resell at the typical price,** not above it. Fast sales beat a little extra profit.
- Keep a simple log of what you paid and what you sold for. Profit from regular flipping is taxable income.

## Troubleshooting

- **"price lookup failed" / eBay shows no prices:** eBay sometimes blocks automated lookups. The tool falls back to the `resale` prices in your config, which you can check by hand using the eBay link that `python -m flipfinder price "item"` prints.
- **"0 listings" for everything:** check that `city` matches your Craigslist address. Craigslist may also be temporarily blocking you if you run it very often, so a few times a day is plenty.
- **Facebook Marketplace isn't scanned automatically:** Facebook requires a login and doesn't allow automated searching. Browse it on your phone and use `check` on anything interesting.

## Tests

```bash
python -m unittest
```
