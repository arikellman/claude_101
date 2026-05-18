@echo off
echo ============================================
echo  Meeting Follow-Up Drafter — First-Time Setup
echo ============================================
echo.
echo Step 1: Installing required package...
pip install anthropic
echo.
echo Step 2: Set your Anthropic API key
echo.
echo   1. Go to: https://console.anthropic.com
echo   2. Click "API Keys" and create a new key
echo   3. Paste it below (it starts with sk-ant-)
echo.
set /p APIKEY="Paste your Anthropic API key: "
setx ANTHROPIC_API_KEY "%APIKEY%"
echo.
echo Step 3: Re-authenticating Google (new Calendar permission needed)
echo A browser window will open. Sign in with your Fabric Google account
echo and click Allow on all permissions. Then come back here.
echo.
pause
del google_token.json 2>nul
python run_auth.py
echo.
echo Step 4: Building your email style profile (scans your sent mail once)
python -m meeting_followup.style_init
echo.
echo ============================================
echo  Setup complete!
echo.
echo  NEXT: Open Claude Code and run /schedule
echo  Paste the prompt from:
echo  meeting_followup\schedule-prompt.md
echo  Tell it to run every 30 minutes.
echo ============================================
pause
