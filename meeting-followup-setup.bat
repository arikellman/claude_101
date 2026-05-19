@echo off
echo ============================================
echo  Meeting Follow-Up Drafter — First-Time Setup
echo ============================================
echo.
echo Step 1: Re-authenticating Google (new Calendar permission needed)
echo A browser window will open. Sign in with your Fabric Google account
echo and click Allow on all permissions. Then come back here.
echo.
pause
del google_token.json 2>nul
python run_auth.py
echo.
echo Step 2: Building your email style profile (scans your sent mail once)
python -m meeting_followup.style_init
echo.
echo ============================================
echo  Setup complete!
echo.
echo  NEXT: Open Claude Code and run /schedule
echo  Paste the contents of:
echo  meeting_followup\scheduled_prompt.md
echo  Tell it to run every 30 minutes.
echo ============================================
pause
