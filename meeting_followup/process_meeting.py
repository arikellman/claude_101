"""Meeting follow-up processor. Runs every 30 min via scheduled agent.

Flow:
  1. Detect new "MTG: <name>" emails from Jack to himself
  2. Look up calendar attendees, skip excluded meetings
  3. Draft follow-up in Jack's style
  4. Save as a Gmail Draft addressed to attendees — Jack reviews and sends
"""
import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import anthropic
from googleapiclient.discovery import build
from google_auth import get_credentials
from meeting_followup.calendar_utils import find_meeting_attendees, should_skip_meeting

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
STYLE_FILE = os.path.join(BASE_DIR, "jack_style_profile.md")
JACK_EMAIL = "avi.jacoby@getfabric.com"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gmail():
    return build("gmail", "v1", credentials=get_credentials())


def _load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"processed_mtg_emails": []}


def _save_state(state: dict):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def _load_style() -> str:
    if os.path.exists(STYLE_FILE):
        with open(STYLE_FILE, "r", encoding="utf-8") as f:
            return f.read()
    return "Professional, direct tone. Bullet points. Clear action items with owners."


def _get_header(headers: list, name: str) -> str:
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def _decode_body(payload: dict) -> str:
    mime = payload.get("mimeType", "")
    if mime in ("text/plain", "text/html"):
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        result = _decode_body(part)
        if result:
            return result
    return ""


# ---------------------------------------------------------------------------
# Step 1 — detect new MTG emails
# ---------------------------------------------------------------------------

def _fetch_new_mtg_emails(service, processed_ids: set) -> list[dict]:
    query = f'from:{JACK_EMAIL} to:{JACK_EMAIL} subject:"MTG:" newer_than:3d'
    resp = service.users().messages().list(
        userId="me", q=query, maxResults=20
    ).execute()

    results = []
    for ref in resp.get("messages", []):
        if ref["id"] in processed_ids:
            continue
        msg = service.users().messages().get(
            userId="me", id=ref["id"], format="full"
        ).execute()
        headers = msg["payload"]["headers"]
        results.append({
            "id": ref["id"],
            "subject": _get_header(headers, "Subject"),
            "body": _decode_body(msg["payload"]) or msg.get("snippet", ""),
        })
    return results


def _parse_meeting_name(subject: str) -> str:
    m = re.match(r"MTG:\s*(.+)", subject, re.IGNORECASE)
    return m.group(1).strip() if m else subject


def _parse_extra_cc(notes: str) -> list[str]:
    """Extract 'CC: email, email' lines from Jack's notes."""
    cc_emails = []
    for line in notes.splitlines():
        m = re.match(r"CC:\s*(.+)", line.strip(), re.IGNORECASE)
        if m:
            cc_emails.extend(e.strip() for e in m.group(1).split(",") if e.strip())
    return cc_emails


# ---------------------------------------------------------------------------
# Step 2 — draft generation
# ---------------------------------------------------------------------------

def _draft_follow_up(meeting_name: str, notes: str, attendees: list[str], style: str) -> str:
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=f"""You draft meeting follow-up emails on behalf of Jack (avi.jacoby@getfabric.com).

Style guide — follow this exactly:
{style}

Always include: meeting summary bullets, decisions (if any), action items with owners.
Write in HTML suitable for email (no <html>/<body> tags, just the inner content).""",
        messages=[{
            "role": "user",
            "content": (
                f'Draft a follow-up for the meeting "{meeting_name}".\n\n'
                f"Attendees: {', '.join(attendees)}\n\n"
                f"Jack's notes:\n{notes}\n\n"
                "Return only the HTML email body."
            ),
        }],
    )
    return resp.content[0].text


# ---------------------------------------------------------------------------
# Step 3 — create Gmail draft
# ---------------------------------------------------------------------------

def _create_gmail_draft(service, to: list[str], subject: str, html_body: str) -> str:
    """Create a draft in Jack's Gmail Drafts folder, pre-addressed and ready to send."""
    msg = MIMEMultipart("alternative")
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    draft = service.users().drafts().create(
        userId="me",
        body={"message": {"raw": raw}}
    ).execute()
    return draft["id"]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Meeting follow-up processor starting...")
    state = _load_state()
    style = _load_style()
    service = _gmail()

    processed_ids = set(state["processed_mtg_emails"])
    new_emails = _fetch_new_mtg_emails(service, processed_ids)
    print(f"New MTG emails: {len(new_emails)}")

    for email in new_emails:
        meeting_name = _parse_meeting_name(email["subject"])
        print(f"  Processing: {meeting_name}")

        attendees = find_meeting_attendees(meeting_name)
        skip, reason = should_skip_meeting(meeting_name, attendees)

        if skip:
            print(f"  Skipping ({reason})")
            state["processed_mtg_emails"].append(email["id"])
            _save_state(state)
            continue

        extra_cc = _parse_extra_cc(email["body"])
        all_recipients = attendees + extra_cc

        draft_html = _draft_follow_up(meeting_name, email["body"], all_recipients, style)
        draft_id = _create_gmail_draft(
            service,
            to=all_recipients,
            subject=f"Follow-up: {meeting_name}",
            html_body=draft_html,
        )

        state["processed_mtg_emails"].append(email["id"])
        _save_state(state)
        print(f"  Gmail draft created (id: {draft_id}): {meeting_name}")

    print("Done.")


if __name__ == "__main__":
    main()
