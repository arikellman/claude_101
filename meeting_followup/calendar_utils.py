"""Google Calendar helpers — find meeting attendees by event name."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from googleapiclient.discovery import build
from google_auth import get_credentials
from datetime import datetime, timedelta, timezone

JACK_EMAIL = "avi.jacoby@getfabric.com"
EXCLUDED_MEETINGS = ["fabric il weekly"]


def _get_service():
    return build("calendar", "v3", credentials=get_credentials())


def find_meeting_attendees(meeting_name: str, lookback_hours: int = 48) -> list[str]:
    """Return attendee emails (excluding Jack) for the calendar event best matching meeting_name."""
    service = _get_service()
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(hours=lookback_hours)).isoformat()
    time_max = now.isoformat()

    result = service.events().list(
        calendarId="primary",
        timeMin=time_min,
        timeMax=time_max,
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    events = result.get("items", [])
    if not events:
        return []

    name_lower = meeting_name.lower().strip()
    name_words = set(name_lower.split())

    best_event = None
    best_score = -1

    for event in events:
        summary = event.get("summary", "").lower().strip()
        summary_words = set(summary.split())
        overlap = len(name_words & summary_words)
        if overlap > best_score or (overlap == best_score and name_lower in summary):
            best_score = overlap
            best_event = event

    if not best_event or best_score == 0:
        return []

    attendees = [
        a["email"]
        for a in best_event.get("attendees", [])
        if a.get("email", "").lower() != JACK_EMAIL.lower()
    ]
    return attendees


def should_skip_meeting(meeting_name: str, attendees: list[str]) -> tuple[bool, str]:
    """Return (skip, reason). Skips excluded meetings and solo meetings."""
    name_lower = meeting_name.lower().strip()
    for excluded in EXCLUDED_MEETINGS:
        if excluded in name_lower:
            return True, f"Excluded meeting: {excluded}"
    if not attendees:
        return True, "No other attendees"
    return False, ""
