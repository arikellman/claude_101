@echo off
echo ============================================
echo  Meeting Follow-Up Drafter — Setup
echo ============================================
echo.
echo Building your email style profile...
echo (Scans your sent mail once to learn your writing style)
echo.
python -m meeting_followup.style_init
echo.
echo ============================================
echo  Done!
echo.
echo  LAST STEP: Open Claude Code and run /schedule
echo  Paste the contents of:
echo    meeting_followup\scheduled_prompt.md
echo  Tell it to run every 30 minutes.
echo ============================================
pause
