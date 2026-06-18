"""One-time OAuth setup — finds a free port, writes URL to file, handles callback."""
import os
import socket
import webbrowser
import wsgiref.simple_server
from urllib.parse import parse_qs
from google_auth_oauthlib.flow import InstalledAppFlow
from google_auth import SCOPES, CREDENTIALS_FILE, TOKEN_FILE

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"  # allow HTTP for localhost callback

# Find a free port
with socket.socket() as s:
    s.bind(("", 0))
    PORT = s.getsockname()[1]

flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
flow.redirect_uri = f"http://localhost:{PORT}/"
auth_url, state = flow.authorization_url(access_type="offline", prompt="consent")

# Write URL to file immediately
url_file = os.path.join(BASE_DIR, "auth_url.txt")
with open(url_file, "w") as f:
    f.write(auth_url)

print(f"\nOpen this URL in your browser (choose your getfabric.com account):\n\n{auth_url}\n", flush=True)
print(f"(Also saved to auth_url.txt — port {PORT})\n", flush=True)

# Auto-open the consent page so it's effectively one click
try:
    webbrowser.open(auth_url)
    print("Attempted to open your default browser automatically...", flush=True)
except Exception:
    pass

print("Waiting for authorization callback...", flush=True)

# Minimal WSGI app to capture the OAuth callback
result = {}

def callback_app(environ, start_response):
    params = parse_qs(environ.get("QUERY_STRING", ""))
    result["code"] = params.get("code", [None])[0]
    result["state"] = params.get("state", [None])[0]
    start_response("200 OK", [("Content-Type", "text/html")])
    return [b"<html><body><h2>Authorization complete.</h2><p>You can close this tab.</p></body></html>"]

class SilentHandler(wsgiref.simple_server.WSGIRequestHandler):
    def log_message(self, *args):
        pass

server = wsgiref.simple_server.make_server("localhost", PORT, callback_app,
                                            handler_class=SilentHandler)
server.handle_request()
server.server_close()

if not result.get("code"):
    print("ERROR: No auth code received.", flush=True)
    raise SystemExit(1)

# Exchange code for token
redirect_response = f"http://localhost:{PORT}/?code={result['code']}&state={result['state']}"
flow.fetch_token(authorization_response=redirect_response)

with open(TOKEN_FILE, "w") as f:
    f.write(flow.credentials.to_json())

print("Auth complete! Token saved to google_token.json", flush=True)

# Clean up
if os.path.exists(url_file):
    os.remove(url_file)
