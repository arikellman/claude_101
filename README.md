# claude_101

Personal automation scripts — Gmail search/send and a scheduled meeting follow-up
workflow, driven by Claude.

## Gmail scripts

The Gmail scripts (`gmail_search.py`, `gmail_send.py`,
`meeting_followup/process_meeting.py`) call the
[Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli) instead of
talking to the Gmail API directly, so there is no OAuth code or token handling in
this repo.

### One-time setup

1. Install the CLI (requires Node 18+):

   ```
   npm install -g @googleworkspace/cli
   ```

   (Homebrew: `brew install googleworkspace-cli`, or download a binary from the
   [releases page](https://github.com/googleworkspace/cli/releases).)

   **Windows/PowerShell note:** if you get a "running scripts is disabled" error,
   either run `npm.cmd install -g @googleworkspace/cli` instead, run it from
   cmd.exe, or allow local scripts once with
   `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`.

2. Authenticate:

   ```
   gws auth setup    # one-time: creates/uses a GCP project, enables APIs, sets up OAuth
   gws auth login    # pick scopes and log in
   ```

   When prompted for scopes, include at least Gmail **read**, **send**, and
   **compose** (compose is needed for creating drafts).

   If you already have a `client_secret_*.json` Desktop-app OAuth client from the
   previous setup, you can reuse it:

   ```
   GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=./client_secret_XXXX.json gws auth login
   ```

### Usage

```
python gmail_search.py 'from:someone@example.com subject:invoice' -n 5 --json
python gmail_send.py --to a@b.com --subject "Hi" --body-file body.html --attachment report.pdf
python -m meeting_followup.process_meeting fetch
```

The script interfaces are unchanged from the pre-`gws` versions, so the scheduled
meeting follow-up prompt (`meeting_followup/scheduled_prompt.md`) works as before.
