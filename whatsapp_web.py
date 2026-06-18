#!/usr/bin/env python3
"""
whatsapp_web.py — Read recent WhatsApp Web messages for a contact.

First-time setup (opens browser for QR scan, saves session):
    python whatsapp_web.py --auth

Daily use (headless):
    python whatsapp_web.py "John Smith" [--days 7] [--max 10] [--json]
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta

PROFILE_DIR = os.path.join(os.path.expanduser("~"), ".whatsapp-playwright")


def _context(headless=False):
    from playwright.sync_api import sync_playwright
    p = sync_playwright().start()
    args = ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    if not headless:
        # Push window off-screen so it's invisible during scheduled runs
        args += ["--window-position=10000,0", "--window-size=1280,900"]
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=headless,
        args=args,
        ignore_default_args=["--enable-automation"],
        viewport={"width": 1280, "height": 900},
    )
    return p, ctx


def auth():
    """Open a headed browser so you can scan the WhatsApp QR code once."""
    print("Opening WhatsApp Web. Scan the QR code with your phone.")
    print("Once your chats appear, come back here and press Enter.")
    p, ctx = _context(headless=False)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://web.whatsapp.com")
    input("\nPress Enter after WhatsApp Web is fully loaded and your chats are visible...")
    ctx.close()
    p.stop()
    print(f"Session saved to: {PROFILE_DIR}")
    print("Future runs will be headless.")


def get_messages(contact_name, days=7, max_messages=10):
    try:
        from playwright.sync_api import TimeoutError as PWTimeout
    except ImportError:
        print(
            "ERROR: playwright not installed.\n"
            "Run: pip install playwright && python -m playwright install chromium",
            file=sys.stderr,
        )
        return []

    p, ctx = _context(headless=False)
    try:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://web.whatsapp.com", wait_until="domcontentloaded")

        # Confirm session is alive — chat list must appear
        try:
            page.wait_for_selector('[data-testid="chat-list"]', timeout=30_000)
        except PWTimeout:
            print(
                f"WARN: WhatsApp Web session expired or not yet authenticated. "
                f"Run: python whatsapp_web.py --auth",
                file=sys.stderr,
            )
            return []

        # Open search via the container (clicking focuses the inner INPUT)
        try:
            page.click('[data-testid="chat-list-search-container"]', timeout=5_000)
        except PWTimeout:
            print(f"WARN: Could not open WhatsApp search for '{contact_name}'", file=sys.stderr)
            return []

        page.keyboard.type(contact_name, delay=50)
        page.wait_for_timeout(2_000)

        # Find the list item whose title matches the contact name.
        # list-item-0 is always a section header ("Chats") — start from 1.
        clicked = False
        for i in range(1, 20):
            item = page.query_selector(f'[data-testid="list-item-{i}"]')
            if not item:
                break
            title_el = item.query_selector('[data-testid="cell-frame-title"]')
            if title_el and contact_name.lower() in title_el.inner_text().lower():
                item.click()
                clicked = True
                break

        if not clicked:
            print(f"WARN: No WhatsApp contact found matching '{contact_name}'", file=sys.stderr)
            return []

        # Wait for the chat pane to open (intro-panel disappears)
        try:
            page.wait_for_selector('[data-testid="intro-panel"]', state="hidden", timeout=8_000)
        except PWTimeout:
            pass  # some versions don't show intro-panel; proceed anyway
        page.wait_for_timeout(2_000)

        # Collect messages — only .copyable-text rows that have data-pre-plain-text
        # (rows without it are chat-list status previews, not actual messages)
        cutoff = datetime.now() - timedelta(days=days)
        results = []
        rows = page.query_selector_all(".copyable-text")

        for row in rows:
            try:
                pre = row.get_attribute("data-pre-plain-text")
                if not pre:
                    continue  # skip status/preview text from the left panel
                text = row.inner_text().strip()
                if not text:
                    continue
                # pre format: "[HH:MM, M/D/YYYY] Sender Name: "
                try:
                    date_part = pre.strip("[").split("]")[0].split(", ", 1)[1].strip()
                    msg_date = datetime.strptime(date_part, "%m/%d/%Y")
                    if msg_date < cutoff:
                        continue
                except Exception:
                    pass  # keep if date unparseable

                results.append({
                    "contact": contact_name,
                    "timestamp": pre.strip(),
                    "text": text,
                })
                if len(results) >= max_messages:
                    break
            except Exception:
                continue

        return results

    finally:
        ctx.close()
        p.stop()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Read WhatsApp Web messages for a contact.")
    ap.add_argument("contact", nargs="?", help="Contact name to look up")
    ap.add_argument("--auth", action="store_true", help="First-time QR code setup")
    ap.add_argument("--days", type=int, default=7, metavar="N", help="Lookback window (default: 7)")
    ap.add_argument("--max", type=int, default=10, metavar="N", help="Max messages to return (default: 10)")
    ap.add_argument("--json", action="store_true", help="Output as JSON")
    args = ap.parse_args()

    if args.auth:
        auth()
    elif args.contact:
        msgs = get_messages(args.contact, days=args.days, max_messages=args.max)
        if args.json or not sys.stdout.isatty():
            print(json.dumps(msgs, indent=2, ensure_ascii=False))
        else:
            if not msgs:
                print(f"No messages found for '{args.contact}'")
            for m in msgs:
                print(f"{m['timestamp']} {m['text'][:200]}")
    else:
        ap.print_help()
