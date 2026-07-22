#!/usr/bin/env python3
"""Search Gmail and return relevant messages."""

import argparse
import base64
import html
import json
import os
import re
import sys

from googleapiclient.discovery import build
from google_auth import get_credentials


def get_service():
    return build("gmail", "v1", credentials=get_credentials())


def _iter_parts(payload):
    """Yield (mimeType, base64 data) for every leaf part with body data."""
    data = payload.get("body", {}).get("data", "")
    if data:
        yield payload.get("mimeType", ""), data
    for part in payload.get("parts", []):
        yield from _iter_parts(part)


def _html_to_text(html_content: str) -> str:
    """Strip an HTML email body down to readable text."""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", html_content)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|li|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def decode_body(payload):
    """Extract a readable text body from message payload.

    Prefers text/plain; falls back to a stripped text/html part when no
    plain-text part exists (e.g. Zoom's HTML-only notification emails,
    which would otherwise decode to an empty body despite matching a search).
    """
    plain = None
    html_fallback = None
    for mime, data in _iter_parts(payload):
        decoded = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
        if mime == "text/plain" and not plain:
            plain = decoded
        elif mime == "text/html" and not html_fallback:
            html_fallback = decoded
    if plain:
        return plain
    if html_fallback:
        return _html_to_text(html_fallback)
    return ""


def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def search_gmail(query: str, max_results: int = 10, include_body: bool = False):
    service = get_service()
    response = service.users().messages().list(
        userId="me", q=query, maxResults=max_results
    ).execute()

    messages = response.get("messages", [])
    if not messages:
        print("No messages found.")
        return []

    results = []
    for msg_ref in messages:
        msg = service.users().messages().get(
            userId="me",
            id=msg_ref["id"],
            format="full" if include_body else "metadata",
            metadataHeaders=["From", "To", "Subject", "Date"],
        ).execute()

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
