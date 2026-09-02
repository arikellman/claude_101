#!/usr/bin/env python3
"""
Combine the per-page JSON files produced by console_extractor.js (see that
file for how to generate them) into one deduped, human-readable dataset.

Usage:
    python combine_scraped_pages.py --input-dir "C:/Users/you/Downloads" --output startups

Looks for files matching startups_page_*.json in --input-dir, merges every
startup across all of them (deduped by URL), sorts alphabetically by name,
and writes <output>.md (a Markdown table) and <output>.csv.
"""

import argparse
import csv
import glob
import json
import os
import sys


def load_pages(input_dir: str):
    pattern = os.path.join(input_dir, "startups_page_*.json")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"No files matching startups_page_*.json found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    all_startups = {}
    for path in files:
        with open(path, "r", encoding="utf-8") as f:
            try:
                page_data = json.load(f)
            except json.JSONDecodeError as e:
                print(f"Skipping {path}: invalid JSON ({e})", file=sys.stderr)
                continue
        new_count = 0
        for s in page_data:
            url = s.get("url")
            if not url:
                continue
            if url not in all_startups:
                all_startups[url] = s
                new_count += 1
        print(f"{os.path.basename(path)}: {len(page_data)} entries, {new_count} new", file=sys.stderr)

    return list(all_startups.values())


def write_outputs(startups, output_basename: str):
    startups_sorted = sorted(startups, key=lambda s: s.get("name", "").lower())

    csv_path = f"{output_basename}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "details", "url"])
        writer.writeheader()
        for s in startups_sorted:
            writer.writerow({"name": s.get("name", ""), "details": s.get("details", ""), "url": s.get("url", "")})

    md_path = f"{output_basename}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# Start-Up Nation Finder — scraped startups\n\n")
        f.write(f"Total startups found: **{len(startups_sorted)}**\n\n")
        f.write("| # | Name | Details | Link |\n")
        f.write("|---|------|---------|------|\n")
        for i, s in enumerate(startups_sorted, start=1):
            name = (s.get("name", "") or "").replace("|", "\\|")
            details = (s.get("details", "") or "").replace("|", "\\|")
            if len(details) > 200:
                details = details[:197] + "..."
            url = s.get("url", "")
            f.write(f"| {i} | {name} | {details} | [link]({url}) |\n")

    return csv_path, md_path


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-dir", default=".", help="Folder containing startups_page_*.json files (e.g. your Downloads folder)")
    parser.add_argument("--output", default="startups_combined")
    args = parser.parse_args()

    startups = load_pages(args.input_dir)
    if not startups:
        print("No startups found across the given files.", file=sys.stderr)
        sys.exit(1)

    csv_path, md_path = write_outputs(startups, args.output)
    print(f"\nDone. {len(startups)} unique startups written to:\n  {csv_path}\n  {md_path}")


if __name__ == "__main__":
    main()
