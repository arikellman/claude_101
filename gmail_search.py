#!/usr/bin/env python3
"""Search Gmail and return relevant messages (via the gws CLI)."""

import argparse
import base64
import json

from gws_client import gws_json


def decode_body(payload):
    """Extract plain text body from message payload."""
    if payload.get("mimeType") == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        result = decode_body(part)
        if result:
            return result
    return ""


def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def search_gmail(query: str, max_results: int = 10, include_body: bool = False):
    response = gws_json(
        "gmail", "users", "messages", "list",
        "--params", json.dumps({"userId": "me", "q": query, "maxResults": max_results}),
    )

    messages = (response or {}).get("messages", [])
    if not messages:
        print("No messages found.")
        return []

    results = []
    for msg_ref in messages:
        msg = gws_json(
            "gmail", "users", "messages", "get",
            "--params", json.dumps({
                "userId": "me",
                "id": msg_ref["id"],
                "format": "full" if include_body else "metadata",
                "metadataHeaders": ["From", "To", "Subject", "Date"],
            }),
        )

        headers = msg.get("payload", {}).get("headers", [])
        entry = {
            "id": msg["id"],
            "date": get_header(headers, "Date"),
            "from": get_header(headers, "From"),
            "to": get_header(headers, "To"),
            "subject": get_header(headers, "Subject"),
            "snippet": msg.get("snippet", ""),
        }
        if include_body:
            entry["body"] = decode_body(msg.get("payload", {}))

        results.append(entry)

    return results


def print_results(results, include_body: bool):
    for i, msg in enumerate(results, 1):
        print(f"\n{'─' * 60}")
        print(f"[{i}] {msg['subject']}")
        print(f"    From:    {msg['from']}")
        print(f"    Date:    {msg['date']}")
        print(f"    Snippet: {msg['snippet'][:200]}")
        if include_body and msg.get("body"):
            print(f"    Body:\n{msg['body'][:1000]}")


def main():
    parser = argparse.ArgumentParser(description="Search Gmail and return messages.")
    parser.add_argument("query", help='Gmail search query (e.g. "from:someone@example.com subject:invoice")')
    parser.add_argument("-n", "--max-results", type=int, default=10, help="Max messages to return (default: 10)")
    parser.add_argument("-b", "--body", action="store_true", help="Include message body in output")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    results = search_gmail(args.query, max_results=args.max_results, include_body=args.body)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_results(results, include_body=args.body)
        print(f"\n{'─' * 60}")
        print(f"Found {len(results)} message(s) for query: {args.query!r}")


if __name__ == "__main__":
    main()
