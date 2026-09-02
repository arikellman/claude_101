#!/usr/bin/env python3
"""
Turn startups_all.json (downloaded by console_fetch_all.js from the site's
JSON search API) into one clean, human-readable table.

Usage:
    python format_api_results.py --input startups_all.json --output startups
"""

import argparse
import csv
import json
import sys

BASE_URL = "https://finder.startupnationcentral.org"


def load_records(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize(records):
    rows = []
    for r in records:
        urlname = (r.get("urlname") or "").lstrip("-")
        rows.append(
            {
                "name": r.get("name", ""),
                "type": r.get("type", ""),
                "sector": r.get("primary_sector", ""),
                "stage": r.get("stage", ""),
                "founded_year": r.get("founded_year", ""),
                "employees": r.get("employees", ""),
                "raised": r.get("raised", ""),
                "oneliner": r.get("oneliner", ""),
                "website": r.get("website", ""),
                "url": f"{BASE_URL}/startups/{urlname}" if urlname else "",
            }
        )
    return rows


def write_outputs(rows, output_basename: str):
    rows_sorted = sorted(rows, key=lambda r: (r.get("name") or "").lower())
    fieldnames = ["name", "type", "sector", "stage", "founded_year", "employees", "raised", "oneliner", "website", "url"]

    csv_path = f"{output_basename}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows_sorted)

    md_path = f"{output_basename}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# Start-Up Nation Finder — scraped startups\n\n")
        f.write(f"Total startups: **{len(rows_sorted)}**\n\n")
        f.write("| # | Name | Sector | Stage | Founded | Employees | One-liner | Link |\n")
        f.write("|---|------|--------|-------|---------|-----------|-----------|------|\n")
        for i, r in enumerate(rows_sorted, start=1):
            name = (r["name"] or "").replace("|", "\\|")
            sector = (r["sector"] or "").replace("|", "\\|")
            stage = (r["stage"] or "").replace("|", "\\|")
            founded = r["founded_year"] or ""
            employees = r["employees"] or ""
            oneliner = (r["oneliner"] or "").replace("|", "\\|")
            if len(oneliner) > 150:
                oneliner = oneliner[:147] + "..."
            link = f"[link]({r['url']})" if r["url"] else ""
            f.write(f"| {i} | {name} | {sector} | {stage} | {founded} | {employees} | {oneliner} | {link} |\n")

    return csv_path, md_path


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", default="startups_all.json")
    parser.add_argument("--output", default="startups")
    args = parser.parse_args()

    try:
        records = load_records(args.input)
    except FileNotFoundError:
        print(f"Could not find {args.input}. Did you download it via console_fetch_all.js?", file=sys.stderr)
        sys.exit(1)

    rows = normalize(records)
    csv_path, md_path = write_outputs(rows, args.output)
    print(f"Done. {len(rows)} startups written to:\n  {csv_path}\n  {md_path}")


if __name__ == "__main__":
    main()
