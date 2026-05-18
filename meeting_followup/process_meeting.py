"""Meeting follow-up processor. Runs every 30 min via scheduled agent.

Flow:
  1. Detect new "MTG: <name>" emails from Jack to himself
  2. Look up calendar attendees, skip excluded meetings
  3. Draft follow-up in Jack's style, email him the draft
  4. On Jack's reply: SEND → sends to attendees, CANCEL → drops,
     anything else → apply edits and send
"""
import base64
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import anthropic
from googleapiclient.discovery import build
from google_auth import get_credentials
from gmail_send import send_email
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
    return {"processed_mtg_emails": [], "pending_approvals": {}}


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


def _strip_reply_chain(text: str) -> str:
    """Keep only the top reply, drop quoted previous messages."""
    # Split on common quoted-reply delimiters
    parts = re.split(
        r"\n[-]{3,}|\nOn .+wrote:|<blockquote|>.*wrote:", text, flags=re.DOTALL
    )
    return parts[0].strip()


def _thread_id_for_message(service, message_id: str) -> str:
    msg = service.users().messages().get(
        userId="me", id=message_id, format="metadata"
    ).execute()
    return msg["threadId"]


def _thread_messages(service, thread_id: str) -> list[dict]:
    thread = service.users().threads().get(
        userId="me", id=thread_id, format="full"
    ).execute()
    return thread.get("messages", [])


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


def _apply_edits(original_html: str, instructions: str, style: str) -> str:
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=f"You edit meeting follow-up emails per instructions. Style guide:\n{style}",
        messages=[{
            "role": "user",
            "content": (
                f"Original draft:\n{original_html}\n\n"
                f"Edit instructions from Jack:\n{instructions}\n\n"
                "Return only the revised HTML email body."
            ),
        }],
    )
    return resp.content[0].text


# ---------------------------------------------------------------------------
# Step 3 — send review email to Jack
# ---------------------------------------------------------------------------

def _send_review_email(service, meeting_name: str, draft_html: str, attendees: list[str]) -> tuple[str, str]:
    recipient_list = ", ".join(attendees)
    body = f"""<p>Here is your draft follow-up for <strong>{meeting_name}</strong>.</p>
<p><em>Recipients: {recipient_list}</em></p>
<hr style="margin:16px 0">
{draft_html}
<hr style="margin:16px 0">
<p><strong>Reply with one of:</strong></p>
<ul>
  <li><strong>SEND</strong> — sends to all attendees as-is</li>
  <li><strong>CANCEL</strong> — no follow-up sent</li>
  <li>Anything else — I'll apply your edits and send automatically</li>
</ul>
<p><em>To add a CC recipient, include a line like: CC: name@company.com</em></p>"""

    subject = f"DRAFT READY: {meeting_name} follow-up"
    msg_id = send_email(JACK_EMAIL, subject, body)
    thread_id = _thread_id_for_message(service, msg_id)
    return msg_id, thread_id


# ---------------------------------------------------------------------------
# Step 4 — check and process Jack's replies
# ---------------------------------------------------------------------------

def _check_replies(service, state: dict) -> list[tuple[str, dict, str]]:
    pending = []
    for thread_id, approval in state["pending_approvals"].items():
        if approval["status"] != "pending":
            continue
        messages = _thread_messages(service, thread_id)
        review_id = approval["review_message_id"]
        # Find the most recent message that isn't our review email
        reply_msg = next(
            (m for m in reversed(messages) if m["id"] != review_id),
            None,
        )
        if reply_msg:
            raw = _decode_body(reply_msg["payload"]) or reply_msg.get("snippet", "")
            # Strip HTML tags for plain-text comparison
            plain = re.sub(r"<[^>]+>", " ", raw)
            clean = _strip_reply_chain(plain).strip()
            if clean:
                pending.append((thread_id, approval, clean))
    return pending


def _process_reply(thread_id: str, approval: dict, reply_text: str, state: dict, style: str):
    command = reply_text.strip().upper()
    extra_cc = _parse_extra_cc(reply_text)
    all_recipients = approval["attendees"] + extra_cc

    if command == "SEND":
        send_email(", ".join(all_recipients), approval["follow_up_subject"], approval["follow_up_html"])
        state["pending_approvals"][thread_id]["status"] = "sent"
        print(f"  Sent follow-up: {approval['meeting_name']}")

    elif command == "CANCEL":
        state["pending_approvals"][thread_id]["status"] = "cancelled"
        print(f"  Cancelled: {approval['meeting_name']}")

    else:
        revised = _apply_edits(approval["follow_up_html"], reply_text, style)
        send_email(", ".join(all_recipients), approval["follow_up_subject"], revised)
        state["pending_approvals"][thread_id]["status"] = "sent_with_edits"
        print(f"  Sent edited follow-up: {approval['meeting_name']}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Meeting follow-up processor starting...")
    state = _load_state()
    style = _load_style()
    service = _gmail()

    # --- Process new MTG trigger emails ---
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

        draft_html = _draft_follow_up(meeting_name, email["body"], attendees, style)
        msg_id, thread_id = _send_review_email(service, meeting_name, draft_html, attendees)

        state["processed_mtg_emails"].append(email["id"])
        state["pending_approvals"][thread_id] = {
            "meeting_name": meeting_name,
            "attendees": attendees + extra_cc,
            "follow_up_subject": f"Follow-up: {meeting_name}",
            "follow_up_html": draft_html,
            "review_message_id": msg_id,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_state(state)
        print(f"  Draft review sent for: {meeting_name}")

    # --- Process Jack's replies to pending drafts ---
    replies = _check_replies(service, state)
    print(f"Pending replies to process: {len(replies)}")

    for thread_id, approval, reply_text in replies:
        _process_reply(thread_id, approval, reply_text, state, style)
        _save_state(state)

    print("Done.")


if __name__ == "__main__":
    main()
