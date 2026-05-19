"""Send email via Gmail API. Usage: python gmail_send.py --to X --subject Y --body-file Z [--attachment PATH]"""
import argparse
import base64
import mimetypes
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

from googleapiclient.discovery import build
from google_auth import get_credentials


def send_email(to: str, subject: str, html_body: str, attachments: list[str] | None = None) -> str:
    service = build("gmail", "v1", credentials=get_credentials())

    if attachments:
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText(html_body, "html"))
        for path in attachments:
            mime_type, _ = mimetypes.guess_type(path)
            main_type, sub_type = (mime_type or "application/octet-stream").split("/", 1)
            with open(path, "rb") as f:
                part = MIMEBase(main_type, sub_type)
                part.set_payload(f.read())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=os.path.basename(path))
            msg.attach(part)
    else:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(html_body, "html"))

    msg["To"] = to
    msg["From"] = "me"
    msg["Subject"] = subject

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = service.users().messages().send(userId="me", body={"raw": raw}).execute()
    print(f"Sent message ID: {result['id']}")
    return result["id"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--to", required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body-file", required=True, help="Path to HTML file")
    parser.add_argument("--attachment", action="append", dest="attachments", help="Path to attachment (repeatable)")
    args = parser.parse_args()

    with open(args.body_file, "r", encoding="utf-8") as f:
        html = f.read()
    send_email(args.to, args.subject, html, args.attachments)


if __name__ == "__main__":
    main()
