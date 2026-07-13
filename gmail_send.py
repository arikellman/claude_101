"""Send email via the gws CLI. Usage: python gmail_send.py --to X --subject Y --body-file Z [--attachment PATH]"""
import argparse

from gws_client import gws_json


def send_email(to: str, subject: str, html_body: str, attachments: list[str] | None = None) -> str:
    args = ["gmail", "+send", "--to", to, "--subject", subject, "--body", html_body, "--html"]
    for path in attachments or []:
        args += ["--attach", path]

    result = gws_json(*args) or {}
    msg_id = result.get("id", "")
    print(f"Sent message ID: {msg_id}")
    return msg_id


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
