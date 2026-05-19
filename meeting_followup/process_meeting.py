"""Meeting follow-up mechanics — Gmail, Calendar, state management.

No AI here. Claude (the scheduled agent) handles drafting.
This script is called as a CLI tool by the scheduled agent prompt.

Commands:
  fetch                         Print JSON list of new unprocessed MTG: emails
  get-attendees <meeting_name>  Print JSON attendee list from Google Calendar
  create-draft <meeting_name> <attendees_csv> <subject> <html_file>
                                Save a Gmail Draft and mark the email processed
  mark-processed <email_id>     Mark an MTG trigger email as processed
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

from googleapiclient.discovery import build
from google_auth import get_credentials
from meeting_followup.calendar_utils import find_meeting_attendees, should_skip_meeting

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
JACK_EMAIL = "avi.jacoby@getfabric.com"


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"processed_mtg_emails": []}


def _save_state(state: dict):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ---------------------------------------------------------------------------
# Gmail helpers
# ---------------------------------------------------------------------------

def _gmail():
    return build("gmail", "v1", credentials=get_credentials())


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
# Commands
# ---------------------------------------------------------------------------

def cmd_fetch():
    """Print JSON list of new unprocessed MTG: emails."""
    service = _gmail()
    state = _load_state()
    processed_ids = set(state["processed_mtg_emails"])

    query = f'from:{JACK_EMAIL} to:{JACK_EMAIL} subject:"MTG:" newer_than:3d'
    resp = service.users().messages().list(userId="me", q=query, maxResults=20).execute()

    results = []
    for ref in resp.get("messages", []):
        if ref["id"] in processed_ids:
            continue
        msg = service.users().messages().get(userId="me", id=ref["id"], format="full").execute()
        headers = msg["payload"]["headers"]
        subject = _get_header(headers, "Subject")
        name_match = re.match(r"MTG:\s*(.+)", subject, re.IGNORECASE)
        results.append({
            "id": ref["id"],
            "subject": subject,
            "meeting_name": name_match.group(1).strip() if name_match else subject,
            "body": _decode_body(msg["payload"]) or msg.get("snippet", ""),
        })

    print(json.dumps(results, indent=2))


def cmd_get_attendees(meeting_name: str):
    """Print JSON with attendees and skip flag for a given meeting name."""
    attendees = find_meeting_attendees(meeting_name)
    skip, reason = should_skip_meeting(meeting_name, attendees)
    print(json.dumps({"attendees": attendees, "skip": skip, "reason": reason}, indent=2))


def cmd_create_draft(meeting_name: str, attendees_csv: str, subject: str, html_file: str):
    """Create a Gmail Draft pre-addressed to attendees."""
    with open(html_file, "r", encoding="utf-8") as f:
        html_body = f.read()

    recipients = [e.strip() for e in attendees_csv.split(",") if e.strip()]

    msg = MIMEMultipart("alternative")
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service = _gmail()
    draft = service.users().drafts().create(
        userId="me", body={"message": {"raw": raw}}
    ).execute()

    print(f"Draft created (id: {draft['id']}) for: {meeting_name}")


def cmd_mark_processed(email_id: str):
    """Mark an MTG trigger email as processed so it isn't picked up again."""
    state = _load_state()
    if email_id not in state["processed_mtg_emails"]:
        state["processed_mtg_emails"].append(email_id)
        _save_state(state)
    print(f"Marked processed: {email_id}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    cmd = args[0]

    if cmd == "fetch":
        cmd_fetch()

    elif cmd == "get-attendees" and len(args) >= 2:
        cmd_get_attendees(args[1])

    elif cmd == "create-draft" and len(args) >= 5:
        cmd_create_draft(args[1], args[2], args[3], args[4])

    elif cmd == "mark-processed" and len(args) >= 2:
        cmd_mark_processed(args[1])

    else:
        print(f"Unknown command or missing arguments: {' '.join(args)}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
