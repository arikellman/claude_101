"""One-time initialization: scan Jack's sent mail and build a reusable style profile.

Run once:  python -m meeting_followup.style_init
Re-run any time Jack wants to refresh his style profile.
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import anthropic
from gmail_search import search_gmail

PROFILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jack_style_profile.md")

DEFAULT_PROFILE = """# Jack's Email Style Profile

## Tone
Professional and direct. Warm but concise — no filler phrases.

## Structure
- Brief opening (1 sentence referencing the meeting)
- **Summary** section: 3–5 bullet points on what was discussed
- **Decisions** section (if any): short bullets
- **Action Items** section: each item on its own line, format: "• [Owner] — [Action] (by [date if mentioned])"
- Short closing line + sign-off

## Sign-off
Jack
"""


def init_style_profile():
    print("Scanning Jack's sent mail for meeting follow-up examples...")

    seen_ids: set[str] = set()
    all_emails: list[dict] = []

    for query in [
        'in:sent subject:"follow-up"',
        'in:sent subject:"recap"',
        'in:sent "action items"',
        'in:sent "next steps"',
    ]:
        for msg in search_gmail(query, max_results=12, include_body=True):
            if msg["id"] not in seen_ids:
                seen_ids.add(msg["id"])
                all_emails.append(msg)

    if not all_emails:
        print("No sent follow-up emails found — writing default profile.")
        _write(DEFAULT_PROFILE)
        return

    print(f"Found {len(all_emails)} emails. Analyzing style with Claude...")

    samples = "\n\n---\n\n".join(
        f"Subject: {e['subject']}\n\n{e.get('body') or e['snippet']}"
        for e in all_emails[:20]
    )

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1500,
        messages=[{
            "role": "user",
            "content": f"""Analyze these emails written by Jack (avi.jacoby@getfabric.com) and extract his writing style for meeting follow-ups.

{samples}

Produce a concise style profile in markdown covering:
1. Tone and voice (formal level, warmth, directness)
2. Typical structure and section headings he uses
3. How he formats action items (ownership, deadlines)
4. Greeting and closing patterns
5. Any recurring phrases or stylistic signatures

Title the document "# Jack's Email Style Profile". Keep it prescriptive — it will be used as instructions for an AI drafter.""",
        }],
    )

    _write(response.content[0].text)
    print(f"Style profile saved to {PROFILE_PATH}")


def _write(content: str):
    with open(PROFILE_PATH, "w", encoding="utf-8") as f:
        f.write(content)


if __name__ == "__main__":
    init_style_profile()
