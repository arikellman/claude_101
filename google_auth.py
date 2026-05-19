"""Unified Google OAuth2 — all scopes in one token."""
import os
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/presentations",
]

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.path.join(BASE_DIR, next(
    f for f in os.listdir(BASE_DIR) if f.startswith("client_secret_")
))
TOKEN_FILE = os.path.join(BASE_DIR, "google_token.json")


def get_credentials():
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            auth_url, _ = flow.authorization_url()
            url_file = os.path.join(BASE_DIR, "auth_url.txt")
            with open(url_file, "w") as f:
                f.write(auth_url)
            print(f"AUTH URL SAVED TO: {url_file}", flush=True)
            creds = flow.run_local_server(port=0, open_browser=False)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return creds
