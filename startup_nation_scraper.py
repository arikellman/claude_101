#!/usr/bin/env python3
"""
Scraper for the Start-Up Nation Finder search results.

STATUS: this fully-automated approach does NOT work against the live site --
Cloudflare Turnstile detects Playwright's automation fingerprint and
re-challenges even after a human manually solves it in headed mode, so it
never gets past the checkpoint. The approach that actually works is the
semi-manual one in console_fetch_all.js + format_api_results.py (solve
Cloudflare once in your normal browser, then a pasted console script pages
through the site's underlying JSON search API). This file is kept for
reference / in case Cloudflare's behavior changes, but use the console
scripts instead.

Iterates https://finder.startupnationcentral.org/startups/search?keywords=<kw>&page=<n>
starting at page 1, rendering each page with a headless browser (the site is a
JS-driven SPA, so a plain HTTP GET will not return the startup cards), and stops
automatically once a page returns no new startups (either an empty results page,
or a page whose startups are all duplicates of ones already seen -- a sign the
site has started looping/clamping the page number).

All startups found across every page are deduped by their detail-page URL and
written out to a single, human-readable file: one Markdown table (default) and
a CSV with the same data for spreadsheet use.

NOTE ON SELECTORS: this was written without live access to the site (network
access to finder.startupnationcentral.org was blocked in the environment this
was authored in), so the scraper does not hardcode brittle CSS classes. Instead
it finds startup entries generically, by locating every link on the page whose
href matches the detail-page URL pattern (/startups/<slug>), which is a very
stable pattern for this kind of directory site regardless of styling. If the
real site uses a different URL shape for startup detail pages, adjust
STARTUP_LINK_PATTERN below -- everything else should keep working.

CLOUDFLARE CHALLENGE: the site is protected by Cloudflare Turnstile ("Performing
security verification"), which blocks plain headless automation. Run with
--headed the first time: a visible browser window opens, you solve the
"Verify you are human" checkbox yourself, and the script then continues
scraping automatically in that same browser session/cookies -- Cloudflare's
clearance cookie carries over to every subsequent page, so this only needs to
be solved once per run.

Usage:
    pip install playwright
    playwright install chromium
    python startup_nation_scraper.py --keywords startup --output startups --headed

Options:
    --keywords      Search keyword(s) to pass as the `keywords` query param (default: startup)
    --start-page    First page number to fetch (default: 1)
    --max-pages     Safety cap on number of pages to fetch (default: 500)
    --delay         Seconds to wait between page loads, be polite (default: 1.5)
    --output        Output file basename, without extension (default: startups_combined)
    --headed        Run the browser with a visible window (needed to solve the
                     Cloudflare check the first time; default: headless)
"""

import argparse
import csv
import re
import sys
import time
from urllib.parse import urljoin, urlparse

BASE_URL = "https://finder.startupnationcentral.org"
SEARCH_PATH = "/startups/search"

# Detail-page links look like /startups/<slug>. Adjust if the real site differs.
STARTUP_LINK_PATTERN = re.compile(r"^/startups/(?!search\b)[^/?#]+/?$", re.IGNORECASE)

# Common cookie-consent button labels to dismiss on first load, if present.
COOKIE_BUTTON_TEXTS = [
    "Accept", "Accept All", "Accept all", "I Agree", "Agree", "Got it", "OK",
]


def build_search_url(keywords: str, page: int) -> str:
    return f"{BASE_URL}{SEARCH_PATH}?keywords={keywords}&page={page}"


def try_dismiss_cookie_banner(page):
    for text in COOKIE_BUTTON_TEXTS:
        try:
            btn = page.get_by_role("button", name=text, exact=False)
            if btn.count() > 0:
                btn.first.click(timeout=1500)
                page.wait_for_timeout(300)
                return
        except Exception:
            continue


def is_cloudflare_challenge(page) -> bool:
    try:
        title = (page.title() or "").lower()
    except Exception:
        title = ""
    if "just a moment" in title:
        return True
    try:
        return page.locator("#challenge-error-text, .cf-turnstile, #cf-chl-widget-hrdnj_response").count() > 0
    except Exception:
        return False


def wait_through_cloudflare_challenge(page, headless: bool, max_wait_seconds: int = 180):
    """
    If the current page is a Cloudflare "Performing security verification"
    challenge, wait for it to clear. In headed mode this gives a human time to
    click the Turnstile checkbox; in headless mode there is no one to solve it,
    so just poll in case it's a fully automatic ("managed", non-interactive)
    challenge, and warn if it never clears.
    """
    if not is_cloudflare_challenge(page):
        return

    if headless:
        print(
            "  Hit a Cloudflare 'Verify you are human' challenge, but running "
            "headless -- there's no one to click it. Re-run with --headed, "
            "solve the checkbox once in the window that opens, and the script "
            "will continue automatically from there.",
            file=sys.stderr,
        )
    else:
        print(
            "  Hit a Cloudflare 'Verify you are human' challenge. A browser "
            "window is open -- please solve it there now (click the "
            "checkbox / complete the puzzle). Waiting...",
            file=sys.stderr,
        )

    waited = 0
    poll_interval = 2
    while waited < max_wait_seconds:
        page.wait_for_timeout(poll_interval * 1000)
        waited += poll_interval
        if not is_cloudflare_challenge(page):
            print("  Challenge cleared, continuing.", file=sys.stderr)
            return

    print(
        f"  Still on the Cloudflare challenge after {max_wait_seconds}s, giving up on this page.",
        file=sys.stderr,
    )


def extract_startups_from_page(page):
    """Return a list of dicts for every distinct startup link found on the page."""
    anchors = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(el => ({href: el.getAttribute('href'), text: el.innerText}))",
    )

    seen_hrefs = set()
    results = []
    for a in anchors:
        href = a.get("href") or ""
        path = urlparse(href).path
        if not STARTUP_LINK_PATTERN.match(path):
            continue
        full_url = urljoin(BASE_URL, href)
        if full_url in seen_hrefs:
            continue
        seen_hrefs.add(full_url)

        name = (a.get("text") or "").strip()
        if not name:
            # Fall back to a slug-derived name if the link text was empty
            # (e.g. the link wraps only an image/logo).
            slug = path.rstrip("/").rsplit("/", 1)[-1]
            name = slug.replace("-", " ").title()

        results.append({"name": name, "url": full_url})

    return results


def enrich_with_context_text(page, startups):
    """
    For each startup link, try to grab nearby text (its card's full text) so we
    can surface a short description/sector/location alongside the name, when
    the site renders that information near the link.
    """
    context_map = page.eval_on_selector_all(
        "a[href]",
        """
        els => els.map(el => {
            let node = el;
            let text = '';
            // Walk up a few ancestor levels to find a reasonably-sized "card"
            // container and grab its full text content.
            for (let i = 0; i < 4 && node; i++) {
                node = node.parentElement;
                if (node) {
                    const t = node.innerText || '';
                    if (t.length > text.length) text = t;
                }
            }
            return {href: el.getAttribute('href'), context: text.trim()};
        })
        """,
    )
    context_by_href = {}
    for item in context_map:
        href = item.get("href") or ""
        path = urlparse(href).path
        if not STARTUP_LINK_PATTERN.match(path):
            continue
        full_url = urljoin(BASE_URL, href)
        ctx = (item.get("context") or "").strip()
        if full_url not in context_by_href or len(ctx) > len(context_by_href[full_url]):
            context_by_href[full_url] = ctx

    for s in startups:
        raw = context_by_href.get(s["url"], "")
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        # Drop the line(s) that just repeat the name itself.
        lines = [ln for ln in lines if ln.lower() != s["name"].lower()]
        s["details"] = " | ".join(lines[:5]) if lines else ""
    return startups


def dump_diagnostics(page):
    """
    Save a screenshot + full HTML of the current page to help diagnose why no
    startup links were found on the first page (e.g. wrong URL pattern, a
    cookie/consent wall, or a bot-check interstitial).
    """
    try:
        page.screenshot(path="debug_first_page.png", full_page=True)
        with open("debug_first_page.html", "w", encoding="utf-8") as f:
            f.write(page.content())
        print(
            "  Wrote debug_first_page.png and debug_first_page.html for inspection.",
            file=sys.stderr,
        )
    except Exception as e:
        print(f"  Could not write diagnostics: {e}", file=sys.stderr)


def scrape(keywords: str, start_page: int, max_pages: int, delay: float, headless: bool):
    from playwright.sync_api import sync_playwright

    all_startups = {}  # url -> row dict, de-duped
    page_num = start_page
    pages_fetched = 0
    consecutive_empty_or_dupe_pages = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        browser_page = browser.new_page()

        while pages_fetched < max_pages:
            url = build_search_url(keywords, page_num)
            print(f"Fetching page {page_num}: {url}", file=sys.stderr)
            try:
                # "networkidle" hangs forever on SPAs with background polling
                # (analytics, chat widgets, etc.) -- wait for the DOM instead,
                # then explicitly wait for startup links to actually render.
                browser_page.goto(url, wait_until="domcontentloaded", timeout=45000)
            except Exception as e:
                print(f"  Failed to load page {page_num}: {e}", file=sys.stderr)
                break

            wait_through_cloudflare_challenge(browser_page, headless)

            if page_num == start_page:
                try_dismiss_cookie_banner(browser_page)

            try:
                browser_page.wait_for_selector('a[href^="/startups/"]', timeout=15000)
            except Exception:
                print(
                    "  No startup links appeared within 15s (page may be empty, "
                    "slow, or use a different URL pattern).",
                    file=sys.stderr,
                )

            # Give any client-side rendering a moment to settle.
            browser_page.wait_for_timeout(int(delay * 1000))

            page_startups = extract_startups_from_page(browser_page)
            page_startups = enrich_with_context_text(browser_page, page_startups)

            if page_num == start_page and len(page_startups) == 0:
                dump_diagnostics(browser_page)

            new_count = 0
            for s in page_startups:
                if s["url"] not in all_startups:
                    all_startups[s["url"]] = s
                    new_count += 1

            print(
                f"  Found {len(page_startups)} startup(s) on page, {new_count} new "
                f"(total so far: {len(all_startups)})",
                file=sys.stderr,
            )

            pages_fetched += 1

            if len(page_startups) == 0 or new_count == 0:
                consecutive_empty_or_dupe_pages += 1
            else:
                consecutive_empty_or_dupe_pages = 0

            # Stop once two pages in a row add nothing new -- guards against a
            # single transient empty/duplicate page (e.g. a slow render).
            if consecutive_empty_or_dupe_pages >= 2:
                print("No new content across two consecutive pages, stopping.", file=sys.stderr)
                break

            page_num += 1
            time.sleep(delay)

        browser.close()

    return list(all_startups.values())


def write_outputs(startups, output_basename: str):
    startups_sorted = sorted(startups, key=lambda s: s["name"].lower())

    csv_path = f"{output_basename}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "details", "url"])
        writer.writeheader()
        writer.writerows(startups_sorted)

    md_path = f"{output_basename}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Start-Up Nation Finder — scraped startups\n\n")
        f.write(f"Total startups found: **{len(startups_sorted)}**\n\n")
        f.write("| # | Name | Details | Link |\n")
        f.write("|---|------|---------|------|\n")
        for i, s in enumerate(startups_sorted, start=1):
            name = s["name"].replace("|", "\\|")
            details = (s.get("details") or "").replace("|", "\\|")
            if len(details) > 200:
                details = details[:197] + "..."
            f.write(f"| {i} | {name} | {details} | [link]({s['url']}) |\n")

    return csv_path, md_path


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keywords", default="startup", help="Search keywords query param")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--max-pages", type=int, default=500)
    parser.add_argument("--delay", type=float, default=1.5)
    parser.add_argument("--output", default="startups_combined")
    parser.add_argument("--headed", action="store_true", help="Run with a visible browser window")
    args = parser.parse_args()

    startups = scrape(
        keywords=args.keywords,
        start_page=args.start_page,
        max_pages=args.max_pages,
        delay=args.delay,
        headless=not args.headed,
    )

    if not startups:
        print("No startups were scraped. Check the site's markup / STARTUP_LINK_PATTERN.", file=sys.stderr)
        sys.exit(1)

    csv_path, md_path = write_outputs(startups, args.output)
    print(f"\nDone. {len(startups)} unique startups written to:\n  {csv_path}\n  {md_path}")


if __name__ == "__main__":
    main()
