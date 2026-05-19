@echo off
echo ============================================
echo  Meeting Follow-Up Drafter — Setup
echo ============================================
echo.

echo Step 1: Checking Python...
python --version
if errorlevel 1 (
    echo ERROR: Python not found. Install from https://python.org then re-run this.
    pause
    exit /b 1
)
echo.

echo Step 2: Installing required packages...
pip install google-auth google-auth-oauthlib google-api-python-client
echo.

echo Step 3: Authenticating with Google
echo A browser window will open. Sign in with your Fabric Google account
echo and click Allow on all permissions. Then come back here.
echo.
pause
python run_auth.py
if errorlevel 1 (
    echo ERROR: Authentication failed. Check that client_secret_*.json is in this folder.
    pause
    exit /b 1
)
echo.

echo Step 4: Building your email style profile (scans your sent mail once)...
python -m meeting_followup.style_init
echo.

echo ============================================
echo  Setup complete!
echo.
echo  LAST STEP: Open Claude Code and run /schedule
echo  Paste the contents of:
echo    meeting_followup\scheduled_prompt.md
echo  Tell it to run every 30 minutes.
echo ============================================
pause
